// Implementation of the rewards module's public operations (see
// contract.ts).
//
// Conventions (IMPLEMENTATION-STACK §3/§8): all SQL goes through the db
// port with `$n` placeholders; ids are uuids minted by PostgreSQL
// (`gen_random_uuid()`); `recorded_at`/`settled_at`/`updated_at` come from
// the injectable clock and are never caller-supplied; every statement is
// scoped by the explicit TenantContext (ADR-0001) — cross-tenant access is
// indistinguishable from a missing record (`reward_not_found` /
// `mission_not_found`), on reads AND on writes.
//
// W043 acceptance is carried by these deliberate properties, all tested:
//   1. EXPLICIT POLICIES ONLY: no reward is ever computed or recorded
//      without the tenant's configured policy row (`policy_not_configured`);
//      writing the policy requires the 'rewards:administer' claim; the
//      policy is a management control (updatable, versioned — history to
//      audit W046) whose exact snapshot is frozen on every reward row.
//   2. POLICY-CONFIGURED REWARDS: the reward (kind, amount, currency)
//      comes ONLY from the matched tier of the evaluated policy — the
//      caller supplies the §8 value assessment, never the reward. The
//      conversion is the pure `evaluateRewardPolicy` (deterministic: same
//      policy + same value ⇒ same reward).
//   3. SEPARATE FROM COMPENSATION/PERFORMANCE: the kind vocabulary is
//      closed to non-compensation shapes, the storage CHECK rejects
//      compensation kinds outright, and no compensation or performance
//      field exists anywhere in the module (tested).
//   4. §20 AUTHORITY GATE: every computed grant is routed through the
//      actions module's uniform gate (`authorizeAction`, kind
//      'contribution-reward', level EXECUTE — the built-in floor
//      approval-gates it): allowed ⇒ minted 'granted', gated ⇒ 'proposed'
//      until the recorded human decision settles it, forbidden ⇒ 'refused'
//      (retained evidence). The requesting principal can never decide its
//      own gate (the actions module's separation of duties).
//   5. MISSION REWARD BUDGET: every reward is bounded by the mission's
//      rewardBudget (read through the missions contract — its types
//      anticipate exactly this) plus its rewardTerms snapshot; granted AND
//      proposed rewards commit budget, declined/refused ones do not; the
//      check is serialized per (tenant, contribution) and re-checked under
//      the transaction-scoped advisory lock (race-safe).
//   6. ONE REWARD PER CONTRIBUTION: UNIQUE (tenant_id, contribution_kind,
//      contribution_id) — re-application is `reward_conflict` (first write
//      wins); the gate request is idempotent on the same key, so retries
//      never duplicate gate history.
//   7. APPEND-ONLY REWARDS: reward records and settlements are committed
//      history — no update/delete operation exists on the contract and
//      PostgreSQL itself rejects UPDATE/DELETE/TRUNCATE via migration 001
//      triggers. The first settlement on a gated reward wins.
//
// Storage shape: `reward_policies` (the tenant's one updatable control),
// `rewards` (the append-only configured-reward records) and
// `reward_settlements` (first-write-wins terminal records, FK-scoped to
// their reward within the tenant).

import { now } from '@/infra/clock';
import { getDb, type DbRow, type Queryable } from '@/infra/db';
import type { TenantContext } from '@/infra/tenant';
import {
  ActionsError,
  authorizeAction,
  getActionRequest,
  listApprovalDecisions,
  type ActionRequest,
} from '@/modules/actions/contract';
import { getMission, MissionsError, type Mission } from '@/modules/missions/contract';
import {
  getAcquisitionPlan,
  KnowledgeAcquisitionError,
  type AcquisitionPlan,
} from '@/modules/knowledge-acquisition/contract';
import { RewardsError } from './errors';
import {
  canAdministerRewards,
  derivedRewardStatus,
  evaluateRewardPolicy,
  mintedStatusForRequestStatus,
  REWARD_ACTION_KIND,
  REWARD_AUTHORITY_LEVEL,
  assertRewardsTenantContext,
  snapshotPolicy,
  validateApplyRewardPolicyInput,
  validateListRewardsQuery,
  validateSetRewardPolicyInput,
  validateSettleRewardInput,
  validateSummarizeRewardsQuery,
  type ValidatedApplyInput,
  type ValidatedListQuery,
  type ValidatedPolicyInput,
} from './validation';
import type {
  ApplyRewardPolicyInput,
  ContributionRefKind,
  ContributionStatus,
  ListRewardsQuery,
  MissionImpactKind,
  Reward,
  RewardApplicationResult,
  RewardKind,
  RewardPolicy,
  RewardPolicyAssessment,
  RewardPolicySnapshot,
  RewardSettlement,
  RewardStatus,
  RewardSummary,
  SetRewardPolicyInput,
  SettleRewardInput,
  SummarizeRewardsQuery,
} from './types';

// ---------------------------------------------------------------------------
// Wiring constants (the policy integration points, exported via contract)
// ---------------------------------------------------------------------------

/** The idempotency key that dedupes gate history per contribution. */
function rewardIdempotencyKey(kind: ContributionRefKind, contributionId: string): string {
  return `contribution-reward:${kind}:${contributionId}`;
}

// ---------------------------------------------------------------------------
// Row shapes + mapping
// ---------------------------------------------------------------------------

/** Row shape of `reward_policies`. */
interface PolicyRow extends DbRow {
  id: string;
  tenant_id: string;
  version: number | string;
  qualifying_statuses: unknown;
  min_knowledge_gain: number;
  min_affected_goals: number | string;
  weight_knowledge_gain: number;
  weight_mission_impact: number;
  weight_cost_avoided: number;
  impact_weight_advanced: number;
  impact_weight_resolved: number;
  impact_weight_no_effect: number;
  cost_avoided_saturation: number | string;
  tiers: unknown;
  reward_currency: string;
  note: string | null;
  updated_by_principal: string;
  created_at: Date | string;
  updated_at: Date | string;
}

/** Row shape of `rewards`. */
interface RewardRow extends DbRow {
  id: string;
  tenant_id: string;
  contribution_kind: string;
  contribution_id: string;
  contribution_label: string | null;
  contributor_person_id: string;
  contributor_label: string | null;
  mission_id: string;
  mission_version: number | string;
  mission_reward_budget_amount: number | string;
  mission_reward_budget_currency: string;
  mission_reward_terms: string | null;
  contribution_status: string;
  knowledge_gain: number;
  mission_impact_kind: string;
  affected_goals: unknown;
  cost_avoided_amount: number | string;
  cost_avoided_currency: string;
  value_score: number;
  reward_kind: string;
  reward_amount: number | string;
  reward_currency: string;
  tier_name: string;
  policy_version: number | string;
  policy_snapshot: unknown;
  value_assessment: unknown;
  status: string;
  authority_outcome: string;
  authority_source: string;
  action_request_id: string;
  budget_remaining_before: number | string;
  actor_kind: string;
  actor_id: string | null;
  actor_label: string | null;
  applied_by_principal: string;
  rationale: string | null;
  recorded_at: Date | string;
}

/** Row shape of the reward ⋈ settlement join (the read model). */
interface JoinedRewardRow extends RewardRow {
  settlement_decision: string | null;
  settlement_decided_by_principal: string | null;
  settlement_decided_at: Date | string | null;
  settlement_settled_by_principal: string | null;
  settlement_settled_at: Date | string | null;
}

const REWARD_FIELDS = [
  'id',
  'tenant_id',
  'contribution_kind',
  'contribution_id',
  'contribution_label',
  'contributor_person_id',
  'contributor_label',
  'mission_id',
  'mission_version',
  'mission_reward_budget_amount',
  'mission_reward_budget_currency',
  'mission_reward_terms',
  'contribution_status',
  'knowledge_gain',
  'mission_impact_kind',
  'affected_goals',
  'cost_avoided_amount',
  'cost_avoided_currency',
  'value_score',
  'reward_kind',
  'reward_amount',
  'reward_currency',
  'tier_name',
  'policy_version',
  'policy_snapshot',
  'value_assessment',
  'status',
  'authority_outcome',
  'authority_source',
  'action_request_id',
  'budget_remaining_before',
  'actor_kind',
  'actor_id',
  'actor_label',
  'applied_by_principal',
  'rationale',
  'recorded_at',
] as const;

/** Unqualified reward columns — the INSERT ... RETURNING list. */
const REWARD_COLUMNS = REWARD_FIELDS.join(', ');

/** Tenant-qualified reward columns — the join-select list. */
const QUALIFIED_REWARD_COLUMNS = REWARD_FIELDS.map((field) => `r.${field}`).join(', ');

const REWARD_WITH_SETTLEMENT_FROM = `FROM rewards r
  LEFT JOIN reward_settlements s
    ON s.reward_id = r.id AND s.tenant_id = r.tenant_id`;

const SETTLEMENT_COLUMNS = `s.decision AS settlement_decision,
    s.decided_by_principal AS settlement_decided_by_principal,
    s.decided_at AS settlement_decided_at,
    s.settled_by_principal AS settlement_settled_by_principal,
    s.settled_at AS settlement_settled_at`;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toIso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function toInt(value: number | string): number {
  return typeof value === 'string' ? Number(value) : value;
}

function rewardNotFound(rewardId: string): RewardsError {
  return new RewardsError(
    'reward_not_found',
    `reward '${rewardId}' does not exist in this tenant`,
  );
}

/** jsonb columns arrive parsed on both backends; storage is write-validated. */
function mapAffectedGoals(value: unknown): Reward['value']['affectedGoals'] {
  return Array.isArray(value) ? (value as Reward['value']['affectedGoals']) : [];
}

function mapPolicyTiers(value: unknown): RewardPolicy['tiers'] {
  return Array.isArray(value) ? (value as RewardPolicy['tiers']) : [];
}

function mapQualifyingStatuses(value: unknown): ContributionStatus[] {
  return Array.isArray(value) ? (value as ContributionStatus[]) : [];
}

function mapAssessment(value: unknown): RewardPolicyAssessment {
  return value as RewardPolicyAssessment;
}

function mapPolicySnapshot(value: unknown): RewardPolicySnapshot {
  return value as RewardPolicySnapshot;
}

function mapSettlement(row: JoinedRewardRow): RewardSettlement | null {
  if (row.settlement_decision === null) return null;
  return {
    rewardId: row.id,
    decision: row.settlement_decision as RewardSettlement['decision'], // CHECK-constrained
    decidedByPrincipal: row.settlement_decided_by_principal,
    decidedAt:
      row.settlement_decided_at === null ? null : toIso(row.settlement_decided_at),
    settledByPrincipal: row.settlement_settled_by_principal!,
    settledAt: toIso(row.settlement_settled_at!),
  };
}

function mapReward(row: JoinedRewardRow): Reward {
  const settlement = mapSettlement(row);
  const status: RewardStatus = derivedRewardStatus(
    row.status as 'proposed' | 'granted' | 'refused', // CHECK-constrained
    settlement === null ? null : { decision: settlement.decision },
  );
  return {
    id: row.id,
    tenantId: row.tenant_id,
    contribution: {
      kind: row.contribution_kind as ContributionRefKind, // CHECK-constrained
      id: row.contribution_id,
      label: row.contribution_label,
    },
    contributor: {
      personId: row.contributor_person_id,
      label: row.contributor_label,
    },
    missionId: row.mission_id,
    missionVersion: toInt(row.mission_version),
    missionRewardBudget: {
      amount: toInt(row.mission_reward_budget_amount),
      currency: row.mission_reward_budget_currency,
    },
    missionRewardTerms: row.mission_reward_terms,
    value: {
      status: row.contribution_status as ContributionStatus, // CHECK-constrained
      knowledgeGain: row.knowledge_gain,
      missionImpact: row.mission_impact_kind as MissionImpactKind, // CHECK-constrained
      affectedGoals: mapAffectedGoals(row.affected_goals),
      costAvoided: {
        amount: toInt(row.cost_avoided_amount),
        currency: row.cost_avoided_currency,
      },
    },
    assessment: mapAssessment(row.value_assessment),
    valueScore: row.value_score,
    tier: {
      name: row.tier_name,
      minValueScore: mapPolicySnapshot(row.policy_snapshot).matchedTierFloor,
      kind: row.reward_kind as RewardKind, // CHECK-constrained
      amount: toInt(row.reward_amount),
      currency: row.reward_currency,
    },
    policyVersion: toInt(row.policy_version),
    policySnapshot: mapPolicySnapshot(row.policy_snapshot),
    status,
    authority: {
      outcome: row.authority_outcome as Reward['authority']['outcome'], // CHECK-constrained
      resolvedVia: row.authority_source as Reward['authority']['resolvedVia'], // CHECK-constrained
    },
    actionRequestId: row.action_request_id,
    budgetRemainingBefore: toInt(row.budget_remaining_before),
    actor: {
      kind: row.actor_kind as Reward['actor']['kind'], // CHECK-constrained
      id: row.actor_id,
      label: row.actor_label,
    },
    appliedByPrincipal: row.applied_by_principal,
    rationale: row.rationale,
    recordedAt: toIso(row.recorded_at),
    settlement,
  };
}

function mapPolicyRow(row: PolicyRow): RewardPolicy {
  return {
    version: toInt(row.version),
    qualifyingStatuses: mapQualifyingStatuses(row.qualifying_statuses),
    minKnowledgeGain: row.min_knowledge_gain,
    minAffectedGoals: toInt(row.min_affected_goals),
    weights: {
      knowledgeGain: row.weight_knowledge_gain,
      missionImpact: row.weight_mission_impact,
      costAvoided: row.weight_cost_avoided,
    },
    impactKindWeights: {
      advanced: row.impact_weight_advanced,
      resolved: row.impact_weight_resolved,
      no_effect: row.impact_weight_no_effect,
    },
    costAvoidedSaturation: toInt(row.cost_avoided_saturation),
    tiers: mapPolicyTiers(row.tiers),
    rewardCurrency: row.reward_currency,
    note: row.note,
    updatedByPrincipal: row.updated_by_principal,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

/** True when `error` is a PostgreSQL unique violation naming `table`. */
function isDuplicateKeyOn(error: unknown, table: string): boolean {
  return (
    error instanceof Error &&
    /duplicate key value/i.test(error.message) &&
    error.message.includes(table)
  );
}

/**
 * A stable non-negative bigint for the transaction-scoped advisory lock
 * that serializes reward applications per (tenant, contribution) — FNV-1a
 * 64 over the scoped key (the planner's helper, verbatim discipline).
 * Collisions only over-serialize; they cannot under-serialize because the
 * key is injective over the tuple before hashing.
 */
function rewardLockKey(tenantId: string, kind: string, contributionId: string): string {
  let hash = 0xcbf29ce484222325n;
  const scoped = `${tenantId}:${kind}:${contributionId}`;
  for (let i = 0; i < scoped.length; i += 1) {
    hash ^= BigInt(scoped.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return (hash & 0x7fffffffffffffffn).toString();
}

// ---------------------------------------------------------------------------
// Cross-module wiring
// ---------------------------------------------------------------------------

/**
 * Loads the mission through the missions contract (the sanctioned W011
 * read: missions rewardBudget is what bounds rewards, and rewardTerms is
 * what was promised). Missing, malformed and foreign-tenant mission ids
 * are uniformly `mission_not_found` here (no existence leak — the missions
 * module's own error is remapped, the planner's wrapper precedent).
 */
async function loadMission(ctx: TenantContext, missionId: string): Promise<Mission> {
  try {
    return await getMission(ctx, missionId);
  } catch (error) {
    if (error instanceof MissionsError && error.code === 'mission_not_found') {
      throw new RewardsError(
        'mission_not_found',
        `mission '${missionId}' does not exist in this tenant`,
      );
    }
    throw error;
  }
}

/**
 * Loads + shape-checks the answered ask-person acquisition plan a
 * contribution anchors to (the sanctioned W012 read — the same anchor the
 * contributions module (W042) builds on; see contract.ts). Missing,
 * malformed, foreign-tenant and non-answer plans are uniformly
 * `invalid_contribution_ref`: a foreign-tenant plan id reads exactly like
 * a missing one (no leak).
 */
async function loadAnsweredAskPlan(
  ctx: TenantContext,
  planId: string,
): Promise<AcquisitionPlan> {
  let plan: AcquisitionPlan;
  try {
    plan = await getAcquisitionPlan(ctx, planId);
  } catch (error) {
    if (error instanceof KnowledgeAcquisitionError && error.code === 'plan_not_found') {
      throw new RewardsError(
        'invalid_contribution_ref',
        `acquisition plan '${planId}' does not exist in this tenant`,
      );
    }
    throw error;
  }
  if (plan.decision !== 'selected' || plan.action !== 'ask-person' || plan.chosen === null) {
    throw new RewardsError(
      'invalid_contribution_ref',
      `acquisition plan '${planId}' did not select a person to ask — a knowledge contribution anchors to an answered ask-person plan`,
    );
  }
  if (plan.outcome === null || plan.outcome.outcome !== 'answered') {
    throw new RewardsError(
      'invalid_contribution_ref',
      `acquisition plan '${planId}' carries no answered outcome yet — only a supplied answer is a knowledge contribution`,
    );
  }
  if (plan.chosen.id === null) {
    throw new RewardsError(
      'invalid_contribution_ref',
      `acquisition plan '${planId}' selected a label-only person — the contributing employee cannot be derived`,
    );
  }
  return plan;
}

// ---------------------------------------------------------------------------
// Reward policy management
// ---------------------------------------------------------------------------

const POLICY_COLUMNS = `id, tenant_id, version, qualifying_statuses, min_knowledge_gain,
  min_affected_goals, weight_knowledge_gain, weight_mission_impact, weight_cost_avoided,
  impact_weight_advanced, impact_weight_resolved, impact_weight_no_effect,
  cost_avoided_saturation, tiers, reward_currency, note, updated_by_principal,
  created_at, updated_at`;

/**
 * Commits (or updates) the tenant's explicit reward policy. Claim-gated
 * ('rewards:administer'): a plain member cannot rewrite what converts
 * contributions into rewards. Version 1 on first write; every update
 * increments the version — reward rows freeze the snapshot of the version
 * that decided them.
 */
export async function setRewardPolicy(
  ctx: TenantContext,
  input: SetRewardPolicyInput,
): Promise<RewardPolicy> {
  assertRewardsTenantContext(ctx);
  if (!canAdministerRewards(ctx.authority)) {
    throw new RewardsError(
      'forbidden',
      "configuring the reward policy requires the 'rewards:administer' authority claim",
    );
  }
  const valid: ValidatedPolicyInput = validateSetRewardPolicyInput(input);

  const updatedAt = now();
  const rows = await getDb().query<PolicyRow>(
    `INSERT INTO reward_policies (
       tenant_id, version, qualifying_statuses, min_knowledge_gain, min_affected_goals,
       weight_knowledge_gain, weight_mission_impact, weight_cost_avoided,
       impact_weight_advanced, impact_weight_resolved, impact_weight_no_effect,
       cost_avoided_saturation, tiers, reward_currency, note, updated_by_principal,
       created_at, updated_at
     ) VALUES (
       $1, 1, $2::jsonb, $3, $4,
       $5, $6, $7,
       $8, $9, $10,
       $11, $12::jsonb, $13, $14, $15,
       $16::timestamptz, $16::timestamptz
     )
     ON CONFLICT (tenant_id) DO UPDATE SET
       version = reward_policies.version + 1,
       qualifying_statuses = EXCLUDED.qualifying_statuses,
       min_knowledge_gain = EXCLUDED.min_knowledge_gain,
       min_affected_goals = EXCLUDED.min_affected_goals,
       weight_knowledge_gain = EXCLUDED.weight_knowledge_gain,
       weight_mission_impact = EXCLUDED.weight_mission_impact,
       weight_cost_avoided = EXCLUDED.weight_cost_avoided,
       impact_weight_advanced = EXCLUDED.impact_weight_advanced,
       impact_weight_resolved = EXCLUDED.impact_weight_resolved,
       impact_weight_no_effect = EXCLUDED.impact_weight_no_effect,
       cost_avoided_saturation = EXCLUDED.cost_avoided_saturation,
       tiers = EXCLUDED.tiers,
       reward_currency = EXCLUDED.reward_currency,
       note = EXCLUDED.note,
       updated_by_principal = EXCLUDED.updated_by_principal,
       updated_at = EXCLUDED.updated_at
     RETURNING ${POLICY_COLUMNS}`,
    [
      ctx.tenantId,
      JSON.stringify(valid.qualifyingStatuses),
      valid.minKnowledgeGain,
      valid.minAffectedGoals,
      valid.weights.knowledgeGain,
      valid.weights.missionImpact,
      valid.weights.costAvoided,
      valid.impactKindWeights.advanced,
      valid.impactKindWeights.resolved,
      valid.impactKindWeights.no_effect,
      valid.costAvoidedSaturation,
      JSON.stringify(valid.tiers),
      valid.rewardCurrency,
      valid.note,
      ctx.principalId,
      updatedAt,
    ],
  );
  return mapPolicyRow(rows.rows[0]!);
}

/** The tenant's current reward policy, or null when none is configured. */
export async function getRewardPolicy(ctx: TenantContext): Promise<RewardPolicy | null> {
  assertRewardsTenantContext(ctx);
  const rows = await getDb().query<PolicyRow>(
    `SELECT ${POLICY_COLUMNS} FROM reward_policies WHERE tenant_id = $1`,
    [ctx.tenantId],
  );
  const row = rows.rows[0];
  return row === undefined ? null : mapPolicyRow(row);
}

async function loadRewardPolicy(ctx: TenantContext): Promise<RewardPolicy> {
  const policy = await getRewardPolicy(ctx);
  if (policy === null) {
    throw new RewardsError(
      'policy_not_configured',
      'no reward policy is configured for this tenant — rewards are granted only under an explicit policy (set one first)',
    );
  }
  return policy;
}

// ---------------------------------------------------------------------------
// Budget accounting
// ---------------------------------------------------------------------------

/**
 * The mission reward budget already committed by granted AND proposed
 * rewards (declined and refused ones commit nothing). Settlement-aware:
 * a declined gated reward frees its commitment. Runs on the given
 * Queryable so the locked application transaction sees a stable figure.
 */
async function committedAmountForMission(
  db: Queryable,
  ctx: TenantContext,
  missionId: string,
): Promise<number> {
  const rows = await db.query<{ committed: number | string }>(
    `SELECT COALESCE(SUM(r.reward_amount), 0) AS committed
       FROM rewards r
       LEFT JOIN reward_settlements s
         ON s.reward_id = r.id AND s.tenant_id = r.tenant_id
      WHERE r.tenant_id = $1 AND r.mission_id = $2
        AND ((s.id IS NULL AND r.status IN ('granted', 'proposed')) OR s.decision = 'granted')`,
    [ctx.tenantId, missionId],
  );
  return toInt(rows.rows[0]?.committed ?? 0);
}

// ---------------------------------------------------------------------------
// applyRewardPolicy
// ---------------------------------------------------------------------------

/** The deterministic gate-request payload of one computed reward. */
function rewardActionPayload(
  valid: ValidatedApplyInput,
  contributor: { personId: string; label: string | null },
  missionId: string,
  policyVersion: number,
  assessment: RewardPolicyAssessment,
): Record<string, unknown> {
  return {
    contribution: {
      kind: valid.contribution.kind,
      id: valid.contribution.id,
      label: valid.contribution.label,
    },
    contributor: {
      personId: contributor.personId,
      label: contributor.label,
    },
    missionId,
    policyVersion,
    tier: assessment.tier,
    valueScore: assessment.valueScore,
    contributionStatus: valid.value.status,
    missionImpact: valid.value.missionImpact,
    knowledgeGain: valid.value.knowledgeGain,
    costAvoided: valid.value.costAvoided,
  };
}

/** The deterministic, bounded justification recorded on the gate request. */
function rewardActionJustification(
  valid: ValidatedApplyInput,
  assessment: RewardPolicyAssessment,
  policyVersion: number,
): string {
  const tier = assessment.tier!;
  return (
    `Reward '${tier.name}' (${tier.kind}, ${tier.amount} ${tier.currency} minor units) for ` +
    `${valid.contribution.kind} ${valid.contribution.id} — value score ${assessment.valueScore} ` +
    `under reward policy v${policyVersion}`
  );
}

export async function applyRewardPolicy(
  ctx: TenantContext,
  input: ApplyRewardPolicyInput,
): Promise<RewardApplicationResult> {
  assertRewardsTenantContext(ctx);
  const valid: ValidatedApplyInput = validateApplyRewardPolicyInput(input);

  // --- the explicit policy (no policy, no rewards) ---
  const policy = await loadRewardPolicy(ctx);

  // --- the contribution anchor: derive what can be derived ---
  let contributor: { personId: string; label: string | null };
  let missionId: string;
  if (valid.contribution.kind === 'acquisition-plan') {
    const plan = await loadAnsweredAskPlan(ctx, valid.contribution.id);
    contributor = { personId: plan.chosen!.id!, label: plan.chosen!.label };
    missionId = plan.missionId;
    if (valid.missionId !== null && valid.missionId !== plan.missionId) {
      throw new RewardsError(
        'invalid_reward_input',
        `missionId '${valid.missionId}' does not match the acquisition plan's mission '${plan.missionId}' — the reward's budget context is the contribution's own mission`,
      );
    }
  } else {
    contributor = valid.contribution.contributor!;
    missionId = valid.missionId!;
  }

  // --- the mission whose reward budget governs (the W011 read) ---
  const mission = await loadMission(ctx, missionId);
  if (mission.content.status !== 'active' && mission.content.status !== 'completed') {
    throw new RewardsError(
      'mission_not_rewardable',
      `mission '${missionId}' is ${mission.content.status} — only an active or completed mission's reward budget may govern rewards`,
    );
  }
  const missionRewardBudget = mission.content.rewardBudget;
  if (missionRewardBudget.currency !== policy.rewardCurrency) {
    throw new RewardsError(
      'currency_mismatch',
      `the mission's reward budget is denominated in '${missionRewardBudget.currency}' but the reward policy converts in '${policy.rewardCurrency}' — no cross-currency conversion exists`,
    );
  }

  // --- the deterministic conversion (pure; also currency-guards the
  //     assessed cost-avoided figure) ---
  const assessment = evaluateRewardPolicy(policy, valid.value);
  if (assessment.decision === 'no_reward_due') {
    // Nothing is recorded: the caller receives the full deterministic
    // rationale (the first failing gate / the score below every floor).
    return { assessment, reward: null };
  }

  const tier = assessment.tier!;
  const budgetAmount = missionRewardBudget.amount;

  // --- fast-fail pre-checks (the locked insert re-checks both) ---
  const existing = await getDb().query<{ id: string }>(
    `SELECT id FROM rewards
      WHERE tenant_id = $1 AND contribution_kind = $2 AND contribution_id = $3`,
    [ctx.tenantId, valid.contribution.kind, valid.contribution.id],
  );
  if (existing.rows.length > 0) {
    throw new RewardsError(
      'reward_conflict',
      `a reward already exists for ${valid.contribution.kind} '${valid.contribution.id}' — one configured reward per contribution, first write wins`,
    );
  }
  const committedBefore = await committedAmountForMission(getDb(), ctx, missionId);
  if (committedBefore + tier.amount > budgetAmount) {
    throw new RewardsError(
      'budget_exceeded',
      `the mission's reward budget (${budgetAmount} ${missionRewardBudget.currency} minor units) cannot commit ${tier.amount} more (${committedBefore} already committed by granted/proposed rewards)`,
    );
  }

  // --- the §20 authority gate (the sanctioned W009 dependency) ---
  const request: ActionRequest = await authorizeAction(ctx, {
    actionKind: REWARD_ACTION_KIND,
    authorityLevel: REWARD_AUTHORITY_LEVEL,
    payload: rewardActionPayload(valid, contributor, missionId, policy.version, assessment),
    justification: rewardActionJustification(valid, assessment, policy.version),
    idempotencyKey: rewardIdempotencyKey(valid.contribution.kind, valid.contribution.id),
  });
  const mintedStatus = mintedStatusForRequestStatus(request.status);

  // --- the locked, race-safe commit ---
  const recordedAt = now();
  const inserted = await getDb().transaction(async (tx) => {
    // Serialize applications for this contribution: duplicate detection
    // and budget accounting must see a stable world between read and
    // insert. Transaction-scoped (auto-released); touches no other
    // module's tables. (The gate request was already recorded — a loser
    // of this race leaves at most a replayable, idempotent request.)
    await tx.query(`SELECT pg_advisory_xact_lock($1::bigint)`, [
      rewardLockKey(ctx.tenantId, valid.contribution.kind, valid.contribution.id),
    ]);

    const raced = await tx.query<{ id: string }>(
      `SELECT id FROM rewards
        WHERE tenant_id = $1 AND contribution_kind = $2 AND contribution_id = $3`,
      [ctx.tenantId, valid.contribution.kind, valid.contribution.id],
    );
    if (raced.rows.length > 0) {
      throw new RewardsError(
        'reward_conflict',
        `a reward already exists for ${valid.contribution.kind} '${valid.contribution.id}' — one configured reward per contribution, first write wins`,
      );
    }

    const committed = await committedAmountForMission(tx, ctx, missionId);
    if (committed + tier.amount > budgetAmount) {
      throw new RewardsError(
        'budget_exceeded',
        `the mission's reward budget (${budgetAmount} ${missionRewardBudget.currency} minor units) cannot commit ${tier.amount} more (${committed} already committed by granted/proposed rewards)`,
      );
    }
    const remainingBefore = budgetAmount - committed;

    const result = await tx.query<RewardRow>(
      `INSERT INTO rewards (
         tenant_id, contribution_kind, contribution_id, contribution_label,
         contributor_person_id, contributor_label,
         mission_id, mission_version, mission_reward_budget_amount,
         mission_reward_budget_currency, mission_reward_terms,
         contribution_status, knowledge_gain, mission_impact_kind, affected_goals,
         cost_avoided_amount, cost_avoided_currency, value_score,
         reward_kind, reward_amount, reward_currency, tier_name,
         policy_version, policy_snapshot, value_assessment, status,
         authority_outcome, authority_source, action_request_id, budget_remaining_before,
         actor_kind, actor_id, actor_label, applied_by_principal, rationale, recorded_at
       ) VALUES (
         $1, $2, $3, $4,
         $5, $6,
         $7, $8, $9,
         $10, $11,
         $12, $13, $14, $15::jsonb,
         $16, $17, $18,
         $19, $20, $21, $22,
         $23, $24::jsonb, $25::jsonb, $26,
         $27, $28, $29, $30,
         $31, $32, $33, $34, $35, $36::timestamptz
       ) RETURNING ${REWARD_COLUMNS}`,
      [
        ctx.tenantId,
        valid.contribution.kind,
        valid.contribution.id,
        valid.contribution.label,
        contributor.personId,
        contributor.label,
        missionId,
        mission.version,
        missionRewardBudget.amount,
        missionRewardBudget.currency,
        mission.content.rewardTerms,
        valid.value.status,
        valid.value.knowledgeGain,
        valid.value.missionImpact,
        JSON.stringify(valid.value.affectedGoals),
        valid.value.costAvoided.amount,
        valid.value.costAvoided.currency,
        assessment.valueScore,
        tier.kind,
        tier.amount,
        tier.currency,
        tier.name,
        policy.version,
        JSON.stringify(snapshotPolicy(policy, tier)),
        JSON.stringify(assessment),
        mintedStatus,
        request.evaluation.outcome,
        request.evaluation.resolvedVia,
        request.id,
        remainingBefore,
        valid.actor.kind,
        valid.actor.id,
        valid.actor.label,
        ctx.principalId,
        valid.rationale,
        recordedAt,
      ],
    );
    return result.rows[0]!;
  });

  // A fresh reward has no settlement by construction.
  return {
    assessment,
    reward: mapReward({
      ...inserted,
      settlement_decision: null,
      settlement_decided_by_principal: null,
      settlement_decided_at: null,
      settlement_settled_by_principal: null,
      settlement_settled_at: null,
    }),
  };
}

// ---------------------------------------------------------------------------
// settleReward
// ---------------------------------------------------------------------------

export async function settleReward(
  ctx: TenantContext,
  input: SettleRewardInput,
): Promise<Reward> {
  assertRewardsTenantContext(ctx);
  const valid = validateSettleRewardInput(input);

  const rows = await getDb().query<JoinedRewardRow>(
    `SELECT ${QUALIFIED_REWARD_COLUMNS}, ${SETTLEMENT_COLUMNS}
        ${REWARD_WITH_SETTLEMENT_FROM}
       WHERE r.tenant_id = $1 AND r.id = $2`,
    [ctx.tenantId, valid.rewardId],
  );
  const row = rows.rows[0];
  if (row === undefined) throw rewardNotFound(valid.rewardId);
  if (row.settlement_decision !== null) {
    throw new RewardsError(
      'reward_already_settled',
      `reward '${valid.rewardId}' already carries its terminal settlement — the first settlement wins`,
    );
  }
  if (row.status !== 'proposed') {
    throw new RewardsError(
      'reward_not_proposed',
      `reward '${valid.rewardId}' was minted '${row.status}' — only an approval-gated ('proposed') reward can be settled`,
    );
  }

  // Consume the actions module's frozen decision on this reward's gate
  // request — never a re-derivation (the W054 frozen-consumption
  // discipline).
  const request = await getActionRequest(ctx, { requestId: row.action_request_id });
  if (request.status === 'pending') {
    throw new RewardsError(
      'reward_still_proposed',
      `the action request gating reward '${valid.rewardId}' is still pending a human decision — settle after it is decided`,
    );
  }
  const decision = request.status === 'approved' ? 'granted' : 'declined';

  // The deciding human, from the request's append-only decision trail
  // (provenance garnish — the request's own status and decision time
  // already decide the settlement).
  let decidedByPrincipal: string | null = null;
  let decidedAt: string | null = request.decidedAt === null ? null : toIso(request.decidedAt);
  try {
    const decisions = await listApprovalDecisions(ctx, { requestId: row.action_request_id });
    const human = [...decisions].reverse().find((entry) => entry.decidedBy === 'principal');
    if (human !== undefined) {
      decidedByPrincipal = human.principalId;
      decidedAt = toIso(human.decidedAt);
    }
  } catch (error) {
    if (!(error instanceof ActionsError)) throw error;
  }

  const settledAt = now();
  try {
    await getDb().query(
      `INSERT INTO reward_settlements (
         tenant_id, reward_id, decision, decided_by_principal, decided_at,
         settled_by_principal, settled_at
       ) VALUES ($1, $2, $3, $4, $5::timestamptz, $6, $7::timestamptz)`,
      [
        ctx.tenantId,
        valid.rewardId,
        decision,
        decidedByPrincipal,
        decidedAt,
        ctx.principalId,
        settledAt,
      ],
    );
  } catch (error) {
    if (isDuplicateKeyOn(error, 'reward_settlements')) {
      throw new RewardsError(
        'reward_already_settled',
        `reward '${valid.rewardId}' already carries its terminal settlement — the first settlement wins`,
      );
    }
    throw error;
  }

  const settled = mapReward(row);
  return {
    ...settled,
    status: decision,
    settlement: {
      rewardId: settled.id,
      decision,
      decidedByPrincipal,
      decidedAt,
      settledByPrincipal: ctx.principalId,
      settledAt: toIso(settledAt),
    },
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getReward(ctx: TenantContext, rewardId: string): Promise<Reward> {
  assertRewardsTenantContext(ctx);
  if (typeof rewardId !== 'string' || rewardId.trim() === '') {
    throw rewardNotFound(String(rewardId));
  }
  const trimmed = rewardId.trim();
  if (!UUID_PATTERN.test(trimmed)) {
    // Malformed ids are indistinguishable from missing rewards (no leak).
    throw rewardNotFound(trimmed);
  }

  const rows = await getDb().query<JoinedRewardRow>(
    `SELECT ${QUALIFIED_REWARD_COLUMNS}, ${SETTLEMENT_COLUMNS}
        ${REWARD_WITH_SETTLEMENT_FROM}
       WHERE r.tenant_id = $1 AND r.id = $2`,
    [ctx.tenantId, trimmed.toLowerCase()],
  );
  const row = rows.rows[0];
  if (row === undefined) throw rewardNotFound(trimmed);
  return mapReward(row);
}

export async function listRewards(ctx: TenantContext, query: ListRewardsQuery): Promise<Reward[]> {
  assertRewardsTenantContext(ctx);
  const valid: ValidatedListQuery = validateListRewardsQuery(query);

  const conditions: string[] = ['r.tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  const add = (fragment: string, value: unknown): void => {
    params.push(value);
    conditions.push(fragment.replace('$#', `$${params.length}`));
  };

  if (valid.missionId !== null) add('r.mission_id = $#', valid.missionId);
  if (valid.contributorPersonId !== null) {
    add('r.contributor_person_id = $#', valid.contributorPersonId);
  }
  if (valid.kind !== null) add('r.reward_kind = $#', valid.kind);
  if (valid.status !== null) {
    // The filter is on the DERIVED current status (a settlement wins over
    // the minted status).
    switch (valid.status) {
      case 'granted':
        conditions.push(`((r.status = 'granted' AND s.id IS NULL) OR s.decision = 'granted')`);
        break;
      case 'proposed':
        conditions.push(`(r.status = 'proposed' AND s.id IS NULL)`);
        break;
      case 'declined':
        conditions.push(`s.decision = 'declined'`);
        break;
      case 'refused':
        conditions.push(`(r.status = 'refused' AND s.id IS NULL)`);
        break;
    }
  }

  params.push(valid.limit);
  const limitPlaceholder = `$${params.length}`;
  // Latest first (the actions module's approvals-feed precedent); id
  // breaks ties deterministically.
  const rows = await getDb().query<JoinedRewardRow>(
    `SELECT ${QUALIFIED_REWARD_COLUMNS}, ${SETTLEMENT_COLUMNS}
        ${REWARD_WITH_SETTLEMENT_FROM}
       WHERE ${conditions.join(' AND ')}
       ORDER BY r.recorded_at DESC, r.id DESC
       LIMIT ${limitPlaceholder}`,
    params,
  );
  return rows.rows.map(mapReward);
}

export async function summarizeRewards(
  ctx: TenantContext,
  query: SummarizeRewardsQuery,
): Promise<RewardSummary> {
  assertRewardsTenantContext(ctx);
  const valid = validateSummarizeRewardsQuery(query);

  const conditions: string[] = ['r.tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  const add = (fragment: string, value: unknown): void => {
    params.push(value);
    conditions.push(fragment.replace('$#', `$${params.length}`));
  };
  if (valid.missionId !== null) add('r.mission_id = $#', valid.missionId);
  if (valid.contributorPersonId !== null) {
    add('r.contributor_person_id = $#', valid.contributorPersonId);
  }
  const where = conditions.join(' AND ');

  const groups = await getDb().query<{
    minted_status: string;
    settlement_decision: string | null;
    reward_kind: string;
    reward_currency: string;
    count: number | string;
    amount: number | string;
  }>(
    `SELECT r.status AS minted_status, s.decision AS settlement_decision,
            r.reward_kind, r.reward_currency,
            COUNT(*) AS count, COALESCE(SUM(r.reward_amount), 0) AS amount
       FROM rewards r
       LEFT JOIN reward_settlements s
         ON s.reward_id = r.id AND s.tenant_id = r.tenant_id
      WHERE ${where}
      GROUP BY r.status, s.decision, r.reward_kind, r.reward_currency`,
    params,
  );

  const contributors = await getDb().query<{ contributors: number | string }>(
    `SELECT COUNT(DISTINCT r.contributor_person_id) AS contributors
       FROM rewards r
      WHERE ${where}`,
    params,
  );

  const byStatus: Record<RewardStatus, number> = {
    proposed: 0,
    granted: 0,
    declined: 0,
    refused: 0,
  };
  const kindMap = new Map<
    string,
    { kind: RewardKind; currency: string; count: number; amount: number }
  >();
  const committedMap = new Map<string, { currency: string; count: number; amount: number }>();
  let totalRewards = 0;

  for (const group of groups.rows) {
    const count = toInt(group.count);
    const amount = toInt(group.amount);
    totalRewards += count;
    const status = derivedRewardStatus(
      group.minted_status as 'proposed' | 'granted' | 'refused',
      group.settlement_decision === null
        ? null
        : { decision: group.settlement_decision as 'granted' | 'declined' },
    );
    byStatus[status] += count;

    const kindKey = `${group.reward_kind}/${group.reward_currency}`;
    const kindEntry =
      kindMap.get(kindKey) ??
      {
        kind: group.reward_kind as RewardKind, // CHECK-constrained
        currency: group.reward_currency,
        count: 0,
        amount: 0,
      };
    kindEntry.count += count;
    kindEntry.amount += amount;
    kindMap.set(kindKey, kindEntry);

    if (status === 'granted' || status === 'proposed') {
      const committed =
        committedMap.get(group.reward_currency) ??
        {
          currency: group.reward_currency,
          count: 0,
          amount: 0,
        };
      committed.count += count;
      committed.amount += amount;
      committedMap.set(group.reward_currency, committed);
    }
  }

  return {
    totalRewards,
    byStatus,
    byKind: [...kindMap.values()].sort(
      (a, b) => a.kind.localeCompare(b.kind) || a.currency.localeCompare(b.currency),
    ),
    committedByCurrency: [...committedMap.values()].sort((a, b) =>
      a.currency.localeCompare(b.currency),
    ),
    contributors: toInt(contributors.rows[0]?.contributors ?? 0),
  };
}
