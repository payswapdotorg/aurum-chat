// Implementation of the attention module's public operations (see
// contract.ts).
//
// Conventions (IMPLEMENTATION-STACK §3/§8): all SQL goes through the db
// port with `$n` placeholders; ids are uuids minted by PostgreSQL
// (`gen_random_uuid()`); `recorded_at` comes from the injectable clock and
// is never caller-supplied; every statement is scoped by the explicit
// TenantContext (ADR-0001) — cross-tenant access is indistinguishable
// from a missing record (`run_not_found` / `candidate_not_found`), on
// reads AND on writes: deep-linking a foreign-tenant run or candidate id
// reads the same as a missing one.
//
// W051 acceptance — "material goal/evidence gaps create candidate
// unknowns without a user question; candidate unknowns contain impact,
// urgency, confidence gap and information value; only material unknowns
// become missions; discovery is evidence-linked and auditable;
// end-to-end synthetic proof exists" — is carried by these deliberate
// properties, all tested:
//
//   1. UNPROMPTED (ADR-0017): `runGoalGapDiscovery` accepts NO question
//      anywhere. Its inputs are a trigger, budgets, an actor, metric
//      READINGS (evidence extraction: values + claim provenance) and
//      optional gap PROPOSALS at the bounded-reasoning seam. The unknown's
//      question, consequence, impact, urgency, confidence gap, information
//      value and acquisition paths are COMPUTED by the pure derivation
//      (discovery.ts) from the tenant's ACTIVE goals (fetched through the
//      goals contract), their horizons and the readings — "the LLM may
//      propose, the application decides, records and links evidence."
//   2. POLICY-GATED MISSION CREATION (ADR-0017): only material candidates
//      — decision impact AND expected information value at/above the
//      snapshotted thresholds (evaluateMateriality, the single
//      definition) — are promoted, and promotion always goes THROUGH the
//      sibling contracts: an epistemics unknown (W007 recordUnknown, with
//      the goal subject, the evidence basis and a note naming the run) and
//      a learning mission (W011 createMission, driven by the run's actor
//      with a deterministic definition derived from the candidate). A
//      material candidate whose exact gap already has an ACTIVE mission
//      is recorded 'already_covered' — continuous discovery does not spam
//      duplicates; once that mission goes terminal, the returning need is
//      a NEW unknown + mission (the missions module's own discipline).
//   3. EVIDENCE-LINKED AND AUDITABLE: every candidate cites its evidence
//      basis (claims/beliefs validated readable through the epistemics
//      contract at write time — the missions unknown-refs precedent);
//      affected goals are validated ACTIVE through the goals contract; the
//      originating cognitive execution is validated through the cognition
//      contract; and the run + candidates are append-only rows carrying
//      the policy that governed each decision (PostgreSQL triggers reject
//      UPDATE/DELETE/TRUNCATE outright). Every promotion is
//      reconstructable: which goal, which evidence, which policy, which
//      decision (ADR-0017's consequence clause).
//
// Failure posture: cross-module writes during promotion (recordUnknown /
// createMission / the coverage lookup) are mapped to `promotion_failed`
// with the cause preserved in the message — inputs were validated first,
// so a failure there is a genuine write failure, never a validation
// retry loop.

import { now } from '@/infra/clock';
import { getDb, type DbRow } from '@/infra/db';
import type { TenantContext } from '@/infra/tenant';
import { getExecution, CognitionError } from '@/modules/cognition/contract';
import {
  getBelief,
  getClaim,
  recordUnknown,
  EpistemicsError,
} from '@/modules/epistemics/contract';
import type { Unknown } from '@/modules/epistemics/contract';
import { getGoal, listGoals, GoalsError } from '@/modules/goals/contract';
import type { Goal } from '@/modules/goals/contract';
import {
  createMission,
  listMissions,
  MissionsError,
} from '@/modules/missions/contract';
import type { Mission } from '@/modules/missions/contract';
import { AttentionError } from './errors';
import {
  deriveGoalGapCandidates,
  evaluateMateriality,
  type DerivedGapCandidate,
  type GoalEvidenceSnapshot,
  type GoalSnapshot,
} from './discovery';
import {
  assertAttentionTenantContext,
  validateGetCandidateQuery,
  validateGetRunQuery,
  validateListQuery,
  validateRunInput,
  type ValidatedRunInput,
} from './validation';
import type {
  AcquisitionPath,
  CandidateDisposition,
  CandidateGoalRef,
  CandidateUrgency,
  DiscoveryCandidate,
  DiscoveryParty,
  DiscoveryRun,
  DiscoveryRunCounts,
  DiscoveryRunSummary,
  GapKind,
} from './types';

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

interface RunRow extends DbRow {
  id: string;
  tenant_id: string;
  trigger_kind: string;
  trigger_label: string | null;
  origin_execution_id: string | null;
  actor_kind: string;
  actor_id: string | null;
  actor_label: string | null;
  impact_threshold: number;
  value_threshold: number;
  investigation_budget_amount: number | string;
  investigation_budget_currency: string;
  reward_budget_amount: number | string;
  reward_budget_currency: string;
  ran_by_principal: string;
  rationale: string | null;
  recorded_at: Date | string;
}

interface CandidateRow extends DbRow {
  id: string;
  tenant_id: string;
  run_id: string;
  gap_key: string;
  source: string;
  gap_kind: string;
  affected_goals: unknown;
  missing_knowledge: string;
  consequence: string;
  decision_impact: number;
  urgency: string;
  current_confidence: number;
  required_confidence: number;
  information_value: number;
  evidence_claim_ids: unknown;
  evidence_belief_ids: unknown;
  acquisition_paths: unknown;
  disposition: string;
  epistemics_unknown_id: string | null;
  mission_id: string | null;
  covered_by_mission_id: string | null;
  recorded_at: Date | string;
}

/** Row shape of the summary view (run + derived disposition counts). */
interface RunSummaryRow extends RunRow {
  total: number | string;
  promoted: number | string;
  dismissed: number | string;
  already_covered: number | string;
}

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

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
}): DiscoveryParty {
  return {
    kind: row.actor_kind as DiscoveryParty['kind'], // CHECK-constrained by migration 001
    id: row.actor_id,
    label: row.actor_label,
  };
}

/** jsonb columns arrive parsed on both backends; storage is write-validated. */
function mapGoalRefs(value: unknown): CandidateGoalRef[] {
  return Array.isArray(value) ? (value as CandidateGoalRef[]) : [];
}

function mapPaths(value: unknown): AcquisitionPath[] {
  return Array.isArray(value) ? (value as AcquisitionPath[]) : [];
}

function mapIds(value: unknown): string[] {
  return Array.isArray(value) ? (value as string[]) : [];
}

function mapCandidate(row: CandidateRow): DiscoveryCandidate {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    runId: row.run_id,
    gapKey: row.gap_key,
    source: row.source as 'derived' | 'proposed', // CHECK-constrained
    gapKind: row.gap_kind as GapKind, // CHECK-constrained
    affectedGoals: mapGoalRefs(row.affected_goals),
    missingKnowledge: row.missing_knowledge,
    consequence: row.consequence,
    decisionImpact: row.decision_impact,
    urgency: row.urgency as CandidateUrgency, // CHECK-constrained
    currentConfidence: row.current_confidence,
    requiredConfidence: row.required_confidence,
    informationValue: row.information_value,
    evidenceClaimIds: mapIds(row.evidence_claim_ids),
    evidenceBeliefIds: mapIds(row.evidence_belief_ids),
    acquisitionPaths: mapPaths(row.acquisition_paths),
    disposition: row.disposition as CandidateDisposition, // CHECK-constrained
    epistemicsUnknownId: row.epistemics_unknown_id,
    missionId: row.mission_id,
    coveredByMissionId: row.covered_by_mission_id,
    recordedAt: toIso(row.recorded_at),
  };
}

function runCounts(row: {
  total: number | string;
  promoted: number | string;
  dismissed: number | string;
  already_covered: number | string;
}): DiscoveryRunCounts {
  return {
    total: toInt(row.total),
    promoted: toInt(row.promoted),
    dismissed: toInt(row.dismissed),
    alreadyCovered: toInt(row.already_covered),
  };
}

function mapRunSummary(row: RunSummaryRow): DiscoveryRunSummary {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    trigger: {
      kind: row.trigger_kind as DiscoveryRun['trigger']['kind'], // CHECK-constrained
      label: row.trigger_label,
    },
    originExecutionId: row.origin_execution_id,
    actor: mapActor(row),
    policy: { impactThreshold: row.impact_threshold, valueThreshold: row.value_threshold },
    investigationBudget: {
      amount: toInt(row.investigation_budget_amount),
      currency: row.investigation_budget_currency,
    },
    rewardBudget: {
      amount: toInt(row.reward_budget_amount),
      currency: row.reward_budget_currency,
    },
    counts: runCounts(row),
    rationale: row.rationale,
    ranByPrincipal: row.ran_by_principal,
    recordedAt: toIso(row.recorded_at),
  };
}

// ---------------------------------------------------------------------------
// Error helpers (uniform cross-module semantics — no existence leaks)
// ---------------------------------------------------------------------------

function runNotFound(runId: string): AttentionError {
  return new AttentionError('run_not_found', `discovery run '${runId}' does not exist in this tenant`);
}

function candidateNotFound(candidateId: string): AttentionError {
  return new AttentionError(
    'candidate_not_found',
    `discovery candidate '${candidateId}' does not exist in this tenant`,
  );
}

function invalidGoalRef(goalId: string, reason: string): AttentionError {
  return new AttentionError('invalid_goal_ref', `goal '${goalId}' ${reason}`);
}

function invalidEvidenceRef(id: string): AttentionError {
  return new AttentionError(
    'invalid_evidence_ref',
    `evidence reference '${id}' is not available in this tenant to this principal`,
  );
}

function promotionFailed(cause: string): AttentionError {
  return new AttentionError('promotion_failed', cause);
}

/** Loads one tenant-scoped run row or throws `run_not_found`. */
async function findRunRow(ctx: TenantContext, runId: string): Promise<RunRow> {
  const rows = await getDb().query<RunRow>(
    `SELECT * FROM discovery_runs WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, runId],
  );
  const row = rows.rows[0];
  if (row === undefined) throw runNotFound(runId);
  return row;
}

// ---------------------------------------------------------------------------
// Cross-module validation (contracts only — never sibling tables)
// ---------------------------------------------------------------------------

/** The originating cognitive execution must be readable in this tenant (W013). */
async function validateOriginExecution(ctx: TenantContext, executionId: string): Promise<void> {
  try {
    await getExecution(ctx, { executionId });
  } catch (error) {
    if (error instanceof CognitionError) {
      throw new AttentionError(
        'invalid_origin_ref',
        `originating execution '${executionId}' is not available in this tenant to this principal`,
      );
    }
    throw error;
  }
}

/** One goal must exist and be ACTIVE in this tenant (uniform, no leak). */
async function requireActiveGoal(ctx: TenantContext, goalId: string): Promise<Goal> {
  let goal: Goal;
  try {
    goal = await getGoal(ctx, goalId);
  } catch (error) {
    if (error instanceof GoalsError) {
      throw invalidGoalRef(goalId, 'is not an active goal in this tenant');
    }
    throw error;
  }
  if (goal.content.status !== 'active') {
    throw invalidGoalRef(goalId, `is ${goal.content.status} — discovery evaluates current direction only`);
  }
  return goal;
}

/** Claims/beliefs must be readable in this tenant (the missions unknown-refs precedent). */
async function validateEvidenceRefs(
  ctx: TenantContext,
  claimIds: string[],
  beliefIds: string[],
): Promise<void> {
  for (const claimId of claimIds) {
    try {
      await getClaim(ctx, { claimId });
    } catch (error) {
      if (error instanceof EpistemicsError) throw invalidEvidenceRef(claimId);
      throw error;
    }
  }
  for (const beliefId of beliefIds) {
    try {
      await getBelief(ctx, { beliefId });
    } catch (error) {
      if (error instanceof EpistemicsError) throw invalidEvidenceRef(beliefId);
      throw error;
    }
  }
}

// ---------------------------------------------------------------------------
// Promotion (the application-owned, policy-gated mission creation)
// ---------------------------------------------------------------------------

/** Truncates to `max` characters for the deterministic title composition. */
function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max);
}

function missionTitleFor(candidate: { gapKind: GapKind; metricName: string | null }, goalTitle: string): string {
  if (candidate.metricName !== null) {
    return truncate(`Goal gap · ${goalTitle} · ${candidate.metricName}`, 200);
  }
  return truncate(`Goal gap · ${goalTitle}`, 200);
}

/**
 * Promotes one material candidate THROUGH the sibling contracts: an
 * epistemics unknown first (the first-class consequential gap — subject
 * the primary goal, evidence basis linked, note naming the run so the
 * promotion is traceable from the epistemics side too), then a learning
 * mission driven by the run's actor with a deterministic definition
 * derived from the candidate. Both ids flow onto the append-only
 * candidate row.
 */
async function promoteCandidate(
  ctx: TenantContext,
  run: { id: string; actor: DiscoveryParty; investigationBudget: { amount: number; currency: string }; rewardBudget: { amount: number; currency: string } },
  candidate: {
    gapKey: string;
    gapKind: GapKind;
    metricName: string | null;
    affectedGoalIds: string[];
    missingKnowledge: string;
    consequence: string;
    urgency: CandidateUrgency;
    currentConfidence: number;
    requiredConfidence: number;
    informationValue: number;
    evidenceClaimIds: string[];
    evidenceBeliefIds: string[];
    acquisitionPaths: AcquisitionPath[];
  },
  goalTitles: Map<string, string>,
  goalLabels: Map<string, string | null>,
): Promise<{ epistemicsUnknownId: string; missionId: string }> {
  const primaryGoalId = candidate.affectedGoalIds[0]!;
  const primaryTitle = goalTitles.get(primaryGoalId) ?? primaryGoalId;

  // 1 — the consequential unknown (W007), subject the primary goal.
  let unknown: Unknown;
  try {
    unknown = await recordUnknown(ctx, {
      question: candidate.missingKnowledge,
      consequence: candidate.consequence,
      subject: { kind: 'goals.goal', id: primaryGoalId },
      relatedClaimIds: candidate.evidenceClaimIds,
      relatedBeliefIds: candidate.evidenceBeliefIds,
      note: `goal-gap discovery run ${run.id} · gap ${candidate.gapKey} (${candidate.gapKind})`,
    });
  } catch (error) {
    throw promotionFailed(
      `recording the epistemics unknown for gap '${candidate.gapKey}' failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  // 2 — the learning mission (W011), created by the run's actor with the
  // deterministic definition the candidate dictates.
  let mission: Mission;
  try {
    mission = await createMission(ctx, {
      title: missionTitleFor(candidate, primaryTitle),
      knowledgeObjective: candidate.missingKnowledge,
      affectedGoals: candidate.affectedGoalIds.map((goalId) => ({
        goalId,
        label: goalLabels.get(goalId) ?? goalTitles.get(goalId) ?? null,
      })),
      unknownIds: [unknown.id],
      informationValue: candidate.informationValue,
      urgency: candidate.urgency,
      currentConfidence: candidate.currentConfidence,
      targetConfidence: candidate.requiredConfidence,
      investigationBudget: run.investigationBudget,
      rewardBudget: run.rewardBudget,
      candidateSources: candidate.acquisitionPaths.map((path) => ({
        kind: path.kind,
        id: path.id,
        label: path.label,
      })),
      completionCriteria: `Confidence of at least ${String(candidate.requiredConfidence)} on: ${candidate.missingKnowledge}`,
      actor: { kind: run.actor.kind, id: run.actor.id, label: run.actor.label },
      rationale: `unprompted goal-gap discovery run ${run.id} · gap ${candidate.gapKey}`,
    });
  } catch (error) {
    throw promotionFailed(
      `launching the learning mission for gap '${candidate.gapKey}' failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  return { epistemicsUnknownId: unknown.id, missionId: mission.id };
}

/**
 * The cross-run coverage check: has an earlier promoted candidate with the
 * SAME gap key produced an unknown that still has an ACTIVE mission? Read
 * through the missions contract only (never its tables); latest promoted
 * candidates first, bounded to keep the pass cheap. Returns the covering
 * mission id, or null when the gap is genuinely open again.
 */
async function findCoveringMission(
  ctx: TenantContext,
  gapKey: string,
): Promise<string | null> {
  const prior = await getDb().query<{ epistemics_unknown_id: string }>(
    `SELECT epistemics_unknown_id FROM discovery_candidates
      WHERE tenant_id = $1 AND gap_key = $2 AND disposition = 'promoted'
        AND epistemics_unknown_id IS NOT NULL
      ORDER BY recorded_at DESC, id DESC
      LIMIT 5`,
    [ctx.tenantId, gapKey],
  );
  for (const row of prior.rows) {
    let active: Mission[];
    try {
      active = await listMissions(ctx, {
        unknownId: row.epistemics_unknown_id,
        status: 'active',
      });
    } catch (error) {
      if (error instanceof MissionsError) {
        throw promotionFailed(
          `checking mission coverage for gap '${gapKey}' failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      throw error;
    }
    if (active.length > 0) return active[0]!.id;
  }
  return null;
}

// ---------------------------------------------------------------------------
// runGoalGapDiscovery
// ---------------------------------------------------------------------------

export async function runGoalGapDiscovery(
  ctx: TenantContext,
  input: unknown,
): Promise<DiscoveryRun> {
  assertAttentionTenantContext(ctx);
  const valid: ValidatedRunInput = validateRunInput(input);

  // The loop linkage (W013): validated before anything is written.
  if (valid.originExecutionId !== null) {
    await validateOriginExecution(ctx, valid.originExecutionId);
  }

  // --- the active goals under evaluation (W008, contracts only) ---
  const goalsByid = new Map<string, Goal>();
  if (valid.goalIds === null) {
    const active = await listGoals(ctx, { status: 'active', limit: 500 });
    for (const goal of active) goalsByid.set(goal.id, goal);
  } else {
    for (const goalId of valid.goalIds) {
      const goal = await requireActiveGoal(ctx, goalId);
      goalsByid.set(goal.id, goal);
    }
  }

  // Readings must reference goals under evaluation and metrics those
  // goals actually declare — evidence extraction is about the evaluated
  // direction, nothing else.
  const metricNamesByGoal = new Map<string, Set<string>>();
  for (const goal of goalsByid.values()) {
    metricNamesByGoal.set(
      goal.id,
      new Set(goal.content.metrics.map((metric) => metric.name)),
    );
  }
  for (const reading of valid.readings) {
    const goal = goalsByid.get(reading.goalId);
    if (goal === undefined) {
      throw invalidGoalRef(
        reading.goalId,
        'is not among the active goals under evaluation (scope it with goalIds or drop the reading)',
      );
    }
    const names = metricNamesByGoal.get(reading.goalId)!;
    if (!names.has(reading.metricName)) {
      throw new AttentionError(
        'invalid_reading',
        `readings for goal '${reading.goalId}' reference metric '${reading.metricName}' which the goal's current version does not declare`,
      );
    }
  }

  // Proposals may affect goals beyond the evaluated scope, but every
  // referenced goal must still be an ACTIVE goal of this tenant.
  const goalTitles = new Map<string, string>();
  const goalLabels = new Map<string, string | null>();
  for (const goal of goalsByid.values()) goalTitles.set(goal.id, goal.content.title);
  for (const proposal of valid.proposals) {
    for (const ref of proposal.affectedGoals) {
      if (!goalTitles.has(ref.goalId)) {
        const goal = await requireActiveGoal(ctx, ref.goalId);
        goalTitles.set(goal.id, goal.content.title);
      }
    }
  }

  // --- the evidence basis (W007): every cited claim/belief readable ---
  const claimIds = new Set<string>();
  const beliefIds = new Set<string>();
  for (const reading of valid.readings) {
    for (const id of reading.evidenceClaimIds) claimIds.add(id);
    for (const id of reading.evidenceBeliefIds) beliefIds.add(id);
  }
  for (const proposal of valid.proposals) {
    for (const id of proposal.evidenceClaimIds) claimIds.add(id);
    for (const id of proposal.evidenceBeliefIds) beliefIds.add(id);
  }
  await validateEvidenceRefs(ctx, [...claimIds], [...beliefIds]);

  // --- the unprompted derivation (pure; no question was supplied) ---
  const snapshots: GoalSnapshot[] = [...goalsByid.values()].map((goal) => ({
    id: goal.id,
    title: goal.content.title,
    objective: goal.content.objective,
    desiredState: goal.content.desiredState,
    priority: goal.content.priority,
    horizonEnd: goal.content.horizon.end,
    metrics: goal.content.metrics.map((metric) => ({
      name: metric.name,
      unit: metric.unit,
      direction: metric.direction,
      threshold: metric.threshold,
      lowerBound: metric.lowerBound,
      upperBound: metric.upperBound,
    })),
    evidenceSources: goal.content.evidenceSources.map((source) => ({
      kind: source.kind,
      id: source.id ?? null,
      label: source.label ?? null,
    })),
  }));
  const evidence: Record<string, GoalEvidenceSnapshot> = {};
  for (const reading of valid.readings) {
    const entry = (evidence[reading.goalId] ??= { readings: [] });
    entry.readings!.push({
      metricName: reading.metricName,
      value: reading.value,
      driverConfidence: reading.driverConfidence,
      evidenceClaimIds: reading.evidenceClaimIds,
      evidenceBeliefIds: reading.evidenceBeliefIds,
    });
  }
  const derived = deriveGoalGapCandidates({
    goals: snapshots,
    evidence,
    now: now(),
  });

  // --- merge with the seam proposals; duplicate gap keys are a conflict ---
  interface MergedCandidate {
    gapKey: string;
    gapKind: GapKind;
    metricName: string | null;
    source: 'derived' | 'proposed';
    affectedGoalIds: string[];
    missingKnowledge: string;
    consequence: string;
    decisionImpact: number;
    urgency: CandidateUrgency;
    currentConfidence: number;
    requiredConfidence: number;
    informationValue: number;
    evidenceClaimIds: string[];
    evidenceBeliefIds: string[];
    acquisitionPaths: AcquisitionPath[];
  }
  const merged: MergedCandidate[] = derived.map((candidate: DerivedGapCandidate) => ({
    gapKey: candidate.gapKey,
    gapKind: candidate.gapKind,
    metricName: candidate.metricName,
    source: 'derived',
    affectedGoalIds: candidate.affectedGoalIds,
    missingKnowledge: candidate.missingKnowledge,
    consequence: candidate.consequence,
    decisionImpact: candidate.decisionImpact,
    urgency: candidate.urgency,
    currentConfidence: candidate.currentConfidence,
    requiredConfidence: candidate.requiredConfidence,
    informationValue: candidate.informationValue,
    evidenceClaimIds: candidate.evidenceClaimIds,
    evidenceBeliefIds: candidate.evidenceBeliefIds,
    acquisitionPaths: candidate.acquisitionPaths,
  }));
  for (const proposal of valid.proposals) {
    merged.push({
      gapKey: proposal.gapKey,
      gapKind: 'custom',
      metricName: null,
      source: 'proposed',
      affectedGoalIds: proposal.affectedGoals.map((ref) => ref.goalId),
      missingKnowledge: proposal.missingKnowledge,
      consequence: proposal.consequence,
      decisionImpact: proposal.decisionImpact,
      urgency: proposal.urgency,
      currentConfidence: proposal.currentConfidence,
      requiredConfidence: proposal.requiredConfidence,
      informationValue: proposal.informationValue,
      evidenceClaimIds: proposal.evidenceClaimIds,
      evidenceBeliefIds: proposal.evidenceBeliefIds,
      acquisitionPaths: proposal.acquisitionPaths,
    });
    for (const ref of proposal.affectedGoals) {
      goalLabels.set(ref.goalId, ref.label);
    }
  }
  const seenKeys = new Set<string>();
  for (const candidate of merged) {
    if (seenKeys.has(candidate.gapKey)) {
      throw new AttentionError(
        'discovery_conflict',
        `gap key '${candidate.gapKey}' appears more than once in this pass — one decision per gap`,
      );
    }
    seenKeys.add(candidate.gapKey);
  }

  // --- the run row (the pass's auditable identity + policy snapshot) ---
  const recordedAt = now();
  const insertedRun = await getDb().query<RunRow>(
    `INSERT INTO discovery_runs (
       tenant_id, trigger_kind, trigger_label, origin_execution_id,
       actor_kind, actor_id, actor_label,
       impact_threshold, value_threshold,
       investigation_budget_amount, investigation_budget_currency,
       reward_budget_amount, reward_budget_currency,
       ran_by_principal, rationale, recorded_at
     ) VALUES (
       $1, $2, $3, $4,
       $5, $6, $7,
       $8, $9,
       $10, $11,
       $12, $13,
       $14, $15, $16::timestamptz
     ) RETURNING *`,
    [
      ctx.tenantId,
      valid.trigger.kind,
      valid.trigger.label,
      valid.originExecutionId,
      valid.actor.kind,
      valid.actor.id,
      valid.actor.label,
      valid.policy.impactThreshold,
      valid.policy.valueThreshold,
      valid.investigationBudget.amount,
      valid.investigationBudget.currency,
      valid.rewardBudget.amount,
      valid.rewardBudget.currency,
      ctx.principalId,
      valid.rationale,
      recordedAt,
    ],
  );
  const runRow = insertedRun.rows[0]!;
  const runActor: DiscoveryParty = {
    kind: runRow.actor_kind as DiscoveryParty['kind'], // CHECK-constrained
    id: runRow.actor_id,
    label: runRow.actor_label,
  };
  const runBudgets = {
    investigationBudget: {
      amount: toInt(runRow.investigation_budget_amount),
      currency: runRow.investigation_budget_currency,
    },
    rewardBudget: {
      amount: toInt(runRow.reward_budget_amount),
      currency: runRow.reward_budget_currency,
    },
  };

  // --- the per-candidate decision loop (the policy gate) ---
  for (const candidate of merged) {
    const materiality = evaluateMateriality(candidate, valid.policy);

    if (!materiality.material) {
      await insertCandidateRow(ctx, runRow.id, candidate, 'dismissed', null, null, null);
      continue;
    }

    const coveringMissionId = await findCoveringMission(ctx, candidate.gapKey);
    if (coveringMissionId !== null) {
      await insertCandidateRow(ctx, runRow.id, candidate, 'already_covered', null, null, coveringMissionId);
      continue;
    }

    const promotion = await promoteCandidate(
      ctx,
      { id: runRow.id, actor: runActor, ...runBudgets },
      candidate,
      goalTitles,
      goalLabels,
    );
    await insertCandidateRow(
      ctx,
      runRow.id,
      candidate,
      'promoted',
      promotion.epistemicsUnknownId,
      promotion.missionId,
      null,
    );
  }

  // --- assemble the run view from what was persisted ---
  return await assembleRun(ctx, runRow);
}

/** Inserts one decided candidate row (append-only; ids known at insert). */
async function insertCandidateRow(
  ctx: TenantContext,
  runId: string,
  candidate: {
    gapKey: string;
    gapKind: GapKind;
    source: 'derived' | 'proposed';
    affectedGoalIds: string[];
    missingKnowledge: string;
    consequence: string;
    decisionImpact: number;
    urgency: CandidateUrgency;
    currentConfidence: number;
    requiredConfidence: number;
    informationValue: number;
    evidenceClaimIds: string[];
    evidenceBeliefIds: string[];
    acquisitionPaths: AcquisitionPath[];
  },
  disposition: CandidateDisposition,
  epistemicsUnknownId: string | null,
  missionId: string | null,
  coveredByMissionId: string | null,
): Promise<void> {
  const affectedGoals = candidate.affectedGoalIds.map((goalId) => ({ goalId }));
  await getDb().query(
    `INSERT INTO discovery_candidates (
       tenant_id, run_id, gap_key, source, gap_kind,
       affected_goals, missing_knowledge, consequence,
       decision_impact, urgency, current_confidence, required_confidence, information_value,
       evidence_claim_ids, evidence_belief_ids, acquisition_paths,
       disposition, epistemics_unknown_id, mission_id, covered_by_mission_id, recorded_at
     ) VALUES (
       $1, $2, $3, $4, $5,
       $6::jsonb, $7, $8,
       $9, $10, $11, $12, $13,
       $14::jsonb, $15::jsonb, $16::jsonb,
       $17, $18, $19, $20, $21::timestamptz
     )`,
    [
      ctx.tenantId,
      runId,
      candidate.gapKey,
      candidate.source,
      candidate.gapKind,
      JSON.stringify(affectedGoals),
      candidate.missingKnowledge,
      candidate.consequence,
      candidate.decisionImpact,
      candidate.urgency,
      candidate.currentConfidence,
      candidate.requiredConfidence,
      candidate.informationValue,
      JSON.stringify(candidate.evidenceClaimIds),
      JSON.stringify(candidate.evidenceBeliefIds),
      JSON.stringify(candidate.acquisitionPaths),
      disposition,
      epistemicsUnknownId,
      missionId,
      coveredByMissionId,
      now(),
    ],
  );
}

/** Loads the run's candidates and assembles the full run view. */
async function assembleRun(ctx: TenantContext, runRow: RunRow): Promise<DiscoveryRun> {
  const candidateRows = await getDb().query<CandidateRow>(
    `SELECT * FROM discovery_candidates
      WHERE tenant_id = $1 AND run_id = $2
      ORDER BY recorded_at ASC, id ASC`,
    [ctx.tenantId, runRow.id],
  );
  const candidates = candidateRows.rows.map(mapCandidate);
  const counts: DiscoveryRunCounts = {
    total: candidates.length,
    promoted: candidates.filter((c) => c.disposition === 'promoted').length,
    dismissed: candidates.filter((c) => c.disposition === 'dismissed').length,
    alreadyCovered: candidates.filter((c) => c.disposition === 'already_covered').length,
  };
  return {
    id: runRow.id,
    tenantId: runRow.tenant_id,
    trigger: {
      kind: runRow.trigger_kind as DiscoveryRun['trigger']['kind'], // CHECK-constrained
      label: runRow.trigger_label,
    },
    originExecutionId: runRow.origin_execution_id,
    actor: mapActor(runRow),
    policy: { impactThreshold: runRow.impact_threshold, valueThreshold: runRow.value_threshold },
    investigationBudget: {
      amount: toInt(runRow.investigation_budget_amount),
      currency: runRow.investigation_budget_currency,
    },
    rewardBudget: {
      amount: toInt(runRow.reward_budget_amount),
      currency: runRow.reward_budget_currency,
    },
    counts,
    candidates,
    rationale: runRow.rationale,
    ranByPrincipal: runRow.ran_by_principal,
    recordedAt: toIso(runRow.recorded_at),
  };
}

// ---------------------------------------------------------------------------
// Read surfaces
// ---------------------------------------------------------------------------

export async function getDiscoveryRun(
  ctx: TenantContext,
  query: unknown,
): Promise<DiscoveryRun> {
  assertAttentionTenantContext(ctx);
  const valid = validateGetRunQuery(query);
  const runRow = await findRunRow(ctx, valid.runId);
  return await assembleRun(ctx, runRow);
}

export async function getDiscoveryCandidate(
  ctx: TenantContext,
  query: unknown,
): Promise<DiscoveryCandidate> {
  assertAttentionTenantContext(ctx);
  const valid = validateGetCandidateQuery(query);
  const rows = await getDb().query<CandidateRow>(
    `SELECT * FROM discovery_candidates WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, valid.candidateId],
  );
  const row = rows.rows[0];
  if (row === undefined) throw candidateNotFound(valid.candidateId);
  return mapCandidate(row);
}

const RUN_COUNTS_SELECT = `SELECT
    r.*,
    (SELECT count(*)::int FROM discovery_candidates c
       WHERE c.tenant_id = r.tenant_id AND c.run_id = r.id) AS total,
    (SELECT count(*)::int FROM discovery_candidates c
       WHERE c.tenant_id = r.tenant_id AND c.run_id = r.id AND c.disposition = 'promoted') AS promoted,
    (SELECT count(*)::int FROM discovery_candidates c
       WHERE c.tenant_id = r.tenant_id AND c.run_id = r.id AND c.disposition = 'dismissed') AS dismissed,
    (SELECT count(*)::int FROM discovery_candidates c
       WHERE c.tenant_id = r.tenant_id AND c.run_id = r.id AND c.disposition = 'already_covered') AS already_covered
  FROM discovery_runs r`;

export async function listDiscoveryRuns(
  ctx: TenantContext,
  query: unknown,
): Promise<DiscoveryRunSummary[]> {
  assertAttentionTenantContext(ctx);
  const valid = validateListQuery(query);

  const conditions: string[] = ['r.tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  const add = (fragment: string, value: unknown): void => {
    params.push(value);
    conditions.push(fragment.replace('$#', `$${params.length}`));
  };

  if (valid.triggerKind !== null) add('r.trigger_kind = $#', valid.triggerKind);
  if (valid.originExecutionId !== null) add('r.origin_execution_id = $#', valid.originExecutionId);
  if (valid.affectedGoalId !== null) {
    // jsonb containment: matches any affected-goal entry carrying this id
    // (the missions/learning affected-goal filter precedent).
    add(
      `EXISTS (SELECT 1 FROM discovery_candidates c
         WHERE c.tenant_id = r.tenant_id AND c.run_id = r.id
           AND c.affected_goals @> $#::jsonb)`,
      JSON.stringify([{ goalId: valid.affectedGoalId }]),
    );
  }
  if (valid.disposition !== null) {
    add(
      `EXISTS (SELECT 1 FROM discovery_candidates c
         WHERE c.tenant_id = r.tenant_id AND c.run_id = r.id AND c.disposition = $#)`,
      valid.disposition,
    );
  }

  params.push(valid.limit);
  const limitPlaceholder = `$${params.length}`;
  const rows = await getDb().query<RunSummaryRow>(
    `${RUN_COUNTS_SELECT}
      WHERE ${conditions.join(' AND ')}
      ORDER BY r.recorded_at DESC, r.id DESC
      LIMIT ${limitPlaceholder}`,
    params,
  );
  return rows.rows.map(mapRunSummary);
}
