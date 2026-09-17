// Pure validation/normalization/policy logic of the rewards module (no
// database). Everything a caller may put into a policy, a reward
// application or a settlement crosses these guards first; the SQL CHECK
// constraints in migrations/001-rewards.sql mirror the load-bearing rules
// as defense in depth.
//
// Deliberately strict about unknown keys: a caller can never smuggle
// `version`, `reward`, `amount`, `status`, `actionRequestId`, `budget…`,
// `recordedAt` or principal fields into an application — the policy's
// version, the configured reward (kind/amount/currency come ONLY from the
// matched tier), the minted status, the authority wiring and the audit
// fields are minted by the system. A reward is never caller-forgeable.
//
// `evaluateRewardPolicy` is THE deterministic definition of W043's core —
// "Apply explicit reward policies to valuable knowledge contributions":
// eligibility gates in a fixed order, the three §8 value factors, the
// composite score, and the matched tier. Pure function of (policy, value):
// no clock, no randomness, no IO — the same policy and the same assessment
// always produce the same reward (tested).

import type { TenantContext } from '@/infra/tenant';
import type { AuthorityOutcome } from '@/modules/actions/contract';
import { RewardsError } from './errors';
import type {
  ApplyRewardPolicyInput,
  ContributionRefKind,
  ContributionStatus,
  ListRewardsQuery,
  MissionImpactKind,
  RewardKind,
  RewardPartyKind,
  RewardPolicy,
  RewardPolicyAssessment,
  RewardPolicySnapshot,
  RewardStatus,
  RewardTier,
  SetRewardPolicyInput,
  SettlementDecision,
} from './types';

// ---------------------------------------------------------------------------
// Vocabularies (mirrored by the CHECK constraints in migrations/001)
// ---------------------------------------------------------------------------

export const REWARD_KINDS = ['recognition', 'gift', 'voucher', 'experience', 'donation'] as const;

/**
 * The compensation/performance shapes the reward-kind vocabulary excludes
 * BY CONSTRUCTION (§8: "Rewards must never silently become compensation
 * decisions or performance ratings"). Documentation + test anchor: no kind
 * in REWARD_KINDS may appear here, and the storage layer's CHECK rejects
 * these outright.
 */
export const COMPENSATION_EXCLUDED_KINDS = [
  'salary',
  'salary-adjustment',
  'bonus',
  'commission',
  'raise',
  'merit-increase',
  'promotion',
  'performance-rating',
] as const;

export const CONTRIBUTION_REF_KINDS = ['acquisition-plan', 'knowledge-contribution'] as const;

export const CONTRIBUTION_STATUSES = [
  'pending',
  'validated',
  'contradicted',
  'rejected',
  'measured',
] as const;

export const MISSION_IMPACT_KINDS = ['advanced', 'resolved', 'no_effect'] as const;

export const REWARD_STATUSES = ['proposed', 'granted', 'declined', 'refused'] as const;

export const SETTLEMENT_DECISIONS = ['granted', 'declined'] as const;

export const REWARD_PARTY_KINDS = ['person', 'team', 'agent', 'system', 'external'] as const;

/** The canonical action kind this module registers in the §20 matrix. */
export const REWARD_ACTION_KIND = 'contribution-reward' as const;

/**
 * The authority level of granting a reward: the grant carries configured
 * value to an employee — a consequential action (§20), so it is routed at
 * EXECUTE, which the built-in default matrix approval-gates: by default
 * every reward waits for an explicit human decision, and a tenant must
 * explicitly relax the matrix to auto-grant (silence never becomes a
 * reward).
 */
export const REWARD_AUTHORITY_LEVEL = 'EXECUTE' as const;

/** Authority claim that manages the tenant's reward policy. */
export const REWARDS_AUTHORITY_ADMINISTER = 'rewards:administer';

/** May these authority claims manage the tenant's reward policy? */
export function canAdministerRewards(authorityClaims: readonly string[]): boolean {
  return authorityClaims.includes(REWARDS_AUTHORITY_ADMINISTER);
}

export function isRewardKind(value: unknown): value is RewardKind {
  return typeof value === 'string' && (REWARD_KINDS as readonly string[]).includes(value);
}

export function isContributionRefKind(value: unknown): value is ContributionRefKind {
  return (
    typeof value === 'string' && (CONTRIBUTION_REF_KINDS as readonly string[]).includes(value)
  );
}

export function isContributionStatus(value: unknown): value is ContributionStatus {
  return (
    typeof value === 'string' && (CONTRIBUTION_STATUSES as readonly string[]).includes(value)
  );
}

export function isMissionImpactKind(value: unknown): value is MissionImpactKind {
  return (
    typeof value === 'string' && (MISSION_IMPACT_KINDS as readonly string[]).includes(value)
  );
}

export function isRewardStatus(value: unknown): value is RewardStatus {
  return typeof value === 'string' && (REWARD_STATUSES as readonly string[]).includes(value);
}

export function isSettlementDecision(value: unknown): value is SettlementDecision {
  return (
    typeof value === 'string' && (SETTLEMENT_DECISIONS as readonly string[]).includes(value)
  );
}

export function isRewardPartyKind(value: unknown): value is RewardPartyKind {
  return typeof value === 'string' && (REWARD_PARTY_KINDS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Size caps (mirrors of sibling modules' caps where vocabulary is shared)
// ---------------------------------------------------------------------------

export const MAX_TIERS = 8;
export const MAX_TIER_NAME_LENGTH = 100;
export const MAX_LABEL_LENGTH = 200;
export const MAX_NOTE_LENGTH = 2000;
export const MAX_RATIONALE_LENGTH = 2000;
export const MAX_AFFECTED_GOALS = 16; // the missions module's cap
export const MAX_AMOUNT = 9_007_199_254_740_991; // Number.MAX_SAFE_INTEGER
export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 500;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

// ---------------------------------------------------------------------------
// Input key whitelists
// ---------------------------------------------------------------------------

const POLICY_INPUT_KEYS = [
  'qualifyingStatuses',
  'minKnowledgeGain',
  'minAffectedGoals',
  'weights',
  'impactKindWeights',
  'costAvoidedSaturation',
  'tiers',
  'rewardCurrency',
  'note',
] as const;
const WEIGHTS_KEYS = ['knowledgeGain', 'missionImpact', 'costAvoided'] as const;
const IMPACT_WEIGHTS_KEYS = ['advanced', 'resolved', 'no_effect'] as const;
const TIER_KEYS = ['name', 'minValueScore', 'kind', 'amount'] as const;
const APPLY_INPUT_KEYS = ['contribution', 'missionId', 'value', 'actor', 'rationale'] as const;
const CONTRIBUTION_KEYS = ['kind', 'id', 'label', 'contributor'] as const;
const CONTRIBUTOR_KEYS = ['personId', 'label'] as const;
const VALUE_KEYS = ['status', 'knowledgeGain', 'missionImpact', 'affectedGoals', 'costAvoided'] as const;
const COST_KEYS = ['amount', 'currency'] as const;
const GOAL_REF_KEYS = ['goalId', 'label'] as const;
const ACTOR_KEYS = ['kind', 'id', 'label'] as const;
const SETTLE_INPUT_KEYS = ['rewardId'] as const;
const LIST_QUERY_KEYS = ['missionId', 'contributorPersonId', 'status', 'kind', 'limit'] as const;
const SUMMARIZE_QUERY_KEYS = ['missionId', 'contributorPersonId'] as const;

// ---------------------------------------------------------------------------
// Shared guards
// ---------------------------------------------------------------------------

/** Validates the shape of an explicit TenantContext (throws `invalid_context`). */
export function assertRewardsTenantContext(ctx: TenantContext): void {
  if (typeof ctx.tenantId !== 'string' || ctx.tenantId.trim() === '') {
    throw new RewardsError('invalid_context', 'TenantContext.tenantId must be a non-empty string');
  }
  if (typeof ctx.principalId !== 'string' || ctx.principalId.trim() === '') {
    throw new RewardsError(
      'invalid_context',
      'TenantContext.principalId must be a non-empty string',
    );
  }
  if (!Array.isArray(ctx.authority)) {
    throw new RewardsError('invalid_context', 'TenantContext.authority must be an array of claims');
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  where: string,
  error: (message: string) => RewardsError,
): void {
  for (const key of Object.keys(value)) {
    if (!(allowed as readonly string[]).includes(key)) {
      throw error(`unknown field '${key}' on ${where} (allowed: ${allowed.join(', ')})`);
    }
  }
}

function policyError(message: string): RewardsError {
  return new RewardsError('invalid_policy_input', message);
}

function rewardError(message: string): RewardsError {
  return new RewardsError('invalid_reward_input', message);
}

function queryError(message: string): RewardsError {
  return new RewardsError('invalid_query', message);
}

function requireString(value: unknown, field: string, error: (m: string) => RewardsError): string {
  if (typeof value !== 'string') throw error(`${field} must be a string`);
  const text = value.trim();
  if (text === '') throw error(`${field} must be a non-empty string`);
  return text;
}

function optionalTrimmed(
  value: unknown,
  field: string,
  maxLength: number,
  error: (m: string) => RewardsError,
): string | null {
  if (value === undefined || value === null) return null;
  const text = requireString(value, field, error);
  if (text.length > maxLength) {
    throw error(`${field} must be at most ${maxLength} characters (got ${text.length})`);
  }
  return text;
}

function requireUuid(
  value: unknown,
  field: string,
  error: (m: string) => RewardsError,
): string {
  const text = requireString(value, field, error);
  if (!UUID_PATTERN.test(text)) {
    throw error(`${field} must be a uuid (got '${text}')`);
  }
  return text.toLowerCase();
}

function requireScore(
  value: unknown,
  field: string,
  error: (m: string) => RewardsError,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw error(`${field} must be a finite number in [0, 1] (got ${String(value)})`);
  }
  return value;
}

function requireAmount(
  value: unknown,
  field: string,
  error: (m: string) => RewardsError,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > MAX_AMOUNT
  ) {
    throw error(`${field} must be an integer amount in minor units within [0, ${MAX_AMOUNT}]`);
  }
  return value;
}

function requireCurrency(
  value: unknown,
  field: string,
  error: (m: string) => RewardsError,
): string {
  const text = requireString(value, field, error);
  if (!CURRENCY_PATTERN.test(text)) {
    throw error(`${field} must be a 3-letter uppercase currency code (got '${text}')`);
  }
  return text;
}

// ---------------------------------------------------------------------------
// Policy input
// ---------------------------------------------------------------------------

/** Fully validated + normalized reward policy input. */
export interface ValidatedPolicyInput {
  qualifyingStatuses: ContributionStatus[];
  minKnowledgeGain: number;
  minAffectedGoals: number;
  weights: { knowledgeGain: number; missionImpact: number; costAvoided: number };
  impactKindWeights: { advanced: number; resolved: number; no_effect: number };
  costAvoidedSaturation: number;
  tiers: RewardTier[];
  rewardCurrency: string;
  note: string | null;
}

function validateTier(entry: unknown, where: string): RewardTier {
  if (!isPlainObject(entry)) throw policyError(`${where} must be an object`);
  rejectUnknownKeys(entry, TIER_KEYS, where, policyError);
  const name = requireString(entry.name, `${where}.name`, policyError);
  if (name.length > MAX_TIER_NAME_LENGTH) {
    throw policyError(`${where}.name must be at most ${MAX_TIER_NAME_LENGTH} characters`);
  }
  const minValueScore = requireScore(entry.minValueScore, `${where}.minValueScore`, policyError);
  const kind = entry.kind;
  if (!isRewardKind(kind)) {
    throw policyError(
      `${where}.kind must be one of ${REWARD_KINDS.join(', ')} (got '${String(kind)}') — compensation and performance shapes are not reward kinds`,
    );
  }
  const amount = requireAmount(entry.amount, `${where}.amount`, policyError);
  return { name, minValueScore, kind, amount };
}

/**
 * Validates + normalizes `setRewardPolicy` input. Defaults mirror the
 * documented policy posture: qualifying statuses default to the two
 * valuable ladder states (validated, measured); missing numeric gates
 * default to their permissive floors (0 / no goal requirement), so the
 * explicit parts a tenant must decide are the tiers and the currency.
 */
export function validateSetRewardPolicyInput(input: SetRewardPolicyInput): ValidatedPolicyInput {
  if (!isPlainObject(input)) throw policyError('policy input must be an object');
  rejectUnknownKeys(input, POLICY_INPUT_KEYS, 'policy input', policyError);

  const rawStatuses = input.qualifyingStatuses ?? ['validated', 'measured'];
  if (!Array.isArray(rawStatuses)) {
    throw policyError('qualifyingStatuses must be an array of contribution statuses');
  }
  if (rawStatuses.length === 0) {
    throw policyError('qualifyingStatuses must not be empty — a policy that rewards nothing is not a policy');
  }
  if (rawStatuses.length > CONTRIBUTION_STATUSES.length) {
    throw policyError(`qualifyingStatuses allows at most ${CONTRIBUTION_STATUSES.length} entries`);
  }
  const seen = new Set<string>();
  const qualifyingStatuses: ContributionStatus[] = [];
  for (const entry of rawStatuses) {
    if (!isContributionStatus(entry)) {
      throw policyError(
        `qualifyingStatuses entries must be one of ${CONTRIBUTION_STATUSES.join(', ')} (got '${String(entry)}')`,
      );
    }
    if (seen.has(entry)) throw policyError(`duplicate qualifying status '${entry}'`);
    seen.add(entry);
    qualifyingStatuses.push(entry);
  }

  const minKnowledgeGain = requireScore(
    input.minKnowledgeGain ?? 0,
    'minKnowledgeGain',
    policyError,
  );

  const minAffectedGoalsRaw = input.minAffectedGoals ?? 0;
  if (
    typeof minAffectedGoalsRaw !== 'number' ||
    !Number.isInteger(minAffectedGoalsRaw) ||
    minAffectedGoalsRaw < 0 ||
    minAffectedGoalsRaw > MAX_AFFECTED_GOALS
  ) {
    throw policyError(
      `minAffectedGoals must be an integer in [0, ${MAX_AFFECTED_GOALS}] (got ${String(minAffectedGoalsRaw)})`,
    );
  }
  const minAffectedGoals = minAffectedGoalsRaw;

  const rawWeights = input.weights ?? {};
  if (!isPlainObject(rawWeights)) throw policyError('weights must be an object');
  rejectUnknownKeys(rawWeights, WEIGHTS_KEYS, 'weights', policyError);
  const weights = {
    knowledgeGain: requireScore(
      rawWeights.knowledgeGain ?? 0.4,
      'weights.knowledgeGain',
      policyError,
    ),
    missionImpact: requireScore(
      rawWeights.missionImpact ?? 0.4,
      'weights.missionImpact',
      policyError,
    ),
    costAvoided: requireScore(rawWeights.costAvoided ?? 0.2, 'weights.costAvoided', policyError),
  };

  const rawImpactWeights = input.impactKindWeights ?? {};
  if (!isPlainObject(rawImpactWeights)) throw policyError('impactKindWeights must be an object');
  rejectUnknownKeys(rawImpactWeights, IMPACT_WEIGHTS_KEYS, 'impactKindWeights', policyError);
  const impactKindWeights = {
    advanced: requireScore(
      rawImpactWeights.advanced ?? 0.6,
      'impactKindWeights.advanced',
      policyError,
    ),
    resolved: requireScore(
      rawImpactWeights.resolved ?? 1,
      'impactKindWeights.resolved',
      policyError,
    ),
    no_effect: requireScore(
      rawImpactWeights.no_effect ?? 0,
      'impactKindWeights.no_effect',
      policyError,
    ),
  };

  const costAvoidedSaturation = requireAmount(
    input.costAvoidedSaturation ?? 500_00,
    'costAvoidedSaturation',
    policyError,
  );
  if (costAvoidedSaturation < 1) {
    throw policyError('costAvoidedSaturation must be at least 1 minor unit (a 0 scale point cannot divide)');
  }

  if (!Array.isArray(input.tiers)) throw policyError('tiers must be an array');
  if (input.tiers.length === 0) {
    throw policyError('tiers must not be empty — a reward policy configures at least one tier');
  }
  if (input.tiers.length > MAX_TIERS) {
    throw policyError(`tiers allows at most ${MAX_TIERS} entries (got ${input.tiers.length})`);
  }
  const tiers = input.tiers.map((entry, index) => validateTier(entry, `tiers[${index}]`));
  // Order-independent input, deterministically stored ascending by floor;
  // duplicate floors are ambiguous and duplicate names misidentify tiers
  // (the snapshot's matched-tier floor and the gate justification both
  // name tiers) — both are rejected.
  tiers.sort((a, b) => a.minValueScore - b.minValueScore);
  for (let index = 1; index < tiers.length; index += 1) {
    if (tiers[index]!.minValueScore === tiers[index - 1]!.minValueScore) {
      throw policyError(
        `duplicate tier floor ${tiers[index]!.minValueScore} — each tier needs a distinct minValueScore`,
      );
    }
  }
  const tierNames = new Set<string>();
  for (const tier of tiers) {
    if (tierNames.has(tier.name)) {
      throw policyError(`duplicate tier name '${tier.name}' — each tier needs a distinct name`);
    }
    tierNames.add(tier.name);
  }

  const rewardCurrency = requireCurrency(input.rewardCurrency, 'rewardCurrency', policyError);
  const note = optionalTrimmed(input.note, 'note', MAX_NOTE_LENGTH, policyError);

  return {
    qualifyingStatuses,
    minKnowledgeGain,
    minAffectedGoals,
    weights,
    impactKindWeights,
    costAvoidedSaturation,
    tiers,
    rewardCurrency,
    note,
  };
}

// ---------------------------------------------------------------------------
// applyRewardPolicy input
// ---------------------------------------------------------------------------

/** Fully validated + normalized `applyRewardPolicy` input. */
export interface ValidatedApplyInput {
  contribution: {
    kind: ContributionRefKind;
    id: string;
    label: string | null;
    contributor: { personId: string; label: string | null } | null;
  };
  missionId: string | null;
  value: ValidatedContributionValue;
  actor: { kind: RewardPartyKind; id: string | null; label: string | null };
  rationale: string | null;
}

/** Fully validated + normalized §8 contribution value. */
export interface ValidatedContributionValue {
  status: ContributionStatus;
  knowledgeGain: number;
  missionImpact: MissionImpactKind;
  affectedGoals: { goalId: string; label: string | null }[];
  costAvoided: { amount: number; currency: string };
}

function validateValue(value: unknown): ValidatedContributionValue {
  if (!isPlainObject(value)) throw rewardError('value must be an object');
  rejectUnknownKeys(value, VALUE_KEYS, 'value', rewardError);

  const status = value.status;
  if (!isContributionStatus(status)) {
    throw rewardError(
      `value.status must be one of ${CONTRIBUTION_STATUSES.join(', ')} (got '${String(status)}')`,
    );
  }
  const knowledgeGain = requireScore(value.knowledgeGain, 'value.knowledgeGain', rewardError);
  const missionImpact = value.missionImpact;
  if (!isMissionImpactKind(missionImpact)) {
    throw rewardError(
      `value.missionImpact must be one of ${MISSION_IMPACT_KINDS.join(', ')} (got '${String(missionImpact)}')`,
    );
  }

  const rawGoals = value.affectedGoals ?? [];
  if (!Array.isArray(rawGoals)) {
    throw rewardError('value.affectedGoals must be an array of goal references');
  }
  if (rawGoals.length > MAX_AFFECTED_GOALS) {
    throw rewardError(`value.affectedGoals allows at most ${MAX_AFFECTED_GOALS} entries`);
  }
  const affectedGoals = rawGoals.map((entry, index) => {
    if (!isPlainObject(entry)) throw rewardError(`value.affectedGoals[${index}] must be an object`);
    rejectUnknownKeys(entry, GOAL_REF_KEYS, `value.affectedGoals[${index}]`, rewardError);
    return {
      goalId: requireUuid(entry.goalId, `value.affectedGoals[${index}].goalId`, rewardError),
      label: optionalTrimmed(
        entry.label,
        `value.affectedGoals[${index}].label`,
        MAX_LABEL_LENGTH,
        rewardError,
      ),
    };
  });

  const rawCost = value.costAvoided;
  if (!isPlainObject(rawCost)) throw rewardError('value.costAvoided must be an object');
  rejectUnknownKeys(rawCost, COST_KEYS, 'value.costAvoided', rewardError);
  const costAvoided = {
    amount: requireAmount(rawCost.amount, 'value.costAvoided.amount', rewardError),
    currency: requireCurrency(rawCost.currency, 'value.costAvoided.currency', rewardError),
  };

  return { status, knowledgeGain, missionImpact, affectedGoals, costAvoided };
}

export function validateApplyRewardPolicyInput(input: ApplyRewardPolicyInput): ValidatedApplyInput {
  if (!isPlainObject(input)) throw rewardError('apply input must be an object');
  rejectUnknownKeys(input, APPLY_INPUT_KEYS, 'apply input', rewardError);

  const rawContribution = input.contribution;
  if (!isPlainObject(rawContribution)) {
    throw rewardError('contribution must be an object');
  }
  rejectUnknownKeys(rawContribution, CONTRIBUTION_KEYS, 'contribution', rewardError);
  const kind = rawContribution.kind;
  if (!isContributionRefKind(kind)) {
    throw rewardError(
      `contribution.kind must be one of ${CONTRIBUTION_REF_KINDS.join(', ')} (got '${String(kind)}')`,
    );
  }
  const id = requireUuid(rawContribution.id, 'contribution.id', rewardError);
  const label = optionalTrimmed(
    rawContribution.label,
    'contribution.label',
    MAX_LABEL_LENGTH,
    rewardError,
  );

  let contributor: { personId: string; label: string | null } | null = null;
  if (rawContribution.contributor !== undefined && rawContribution.contributor !== null) {
    if (kind === 'acquisition-plan') {
      throw rewardError(
        'contribution.contributor must not be supplied for an acquisition-plan anchor — the contributing employee is derived from the validated plan',
      );
    }
    const rawContributor = rawContribution.contributor;
    if (!isPlainObject(rawContributor)) {
      throw rewardError('contribution.contributor must be an object');
    }
    rejectUnknownKeys(rawContributor, CONTRIBUTOR_KEYS, 'contribution.contributor', rewardError);
    contributor = {
      personId: requireUuid(
        rawContributor.personId,
        'contribution.contributor.personId',
        rewardError,
      ),
      label: optionalTrimmed(
        rawContributor.label,
        'contribution.contributor.label',
        MAX_LABEL_LENGTH,
        rewardError,
      ),
    };
  }
  if (kind === 'knowledge-contribution' && contributor === null) {
    throw rewardError(
      'contribution.contributor is required for a knowledge-contribution reference — the reward must name the contributing employee',
    );
  }

  let missionId: string | null = null;
  if (input.missionId !== undefined && input.missionId !== null) {
    missionId = requireUuid(input.missionId, 'missionId', rewardError);
  }
  if (kind === 'knowledge-contribution' && missionId === null) {
    throw rewardError(
      'missionId is required for a knowledge-contribution reference — the mission whose reward budget governs',
    );
  }

  const value = validateValue(input.value);

  const rawActor = input.actor;
  if (!isPlainObject(rawActor)) throw rewardError('actor must be an object');
  rejectUnknownKeys(rawActor, ACTOR_KEYS, 'actor', rewardError);
  const actorKind = rawActor.kind;
  if (!isRewardPartyKind(actorKind)) {
    throw rewardError(
      `actor.kind must be one of ${REWARD_PARTY_KINDS.join(', ')} (got '${String(actorKind)}')`,
    );
  }
  const actorId =
    rawActor.id === undefined || rawActor.id === null
      ? null
      : requireUuid(rawActor.id, 'actor.id', rewardError);
  const actorLabel = optionalTrimmed(rawActor.label, 'actor.label', MAX_LABEL_LENGTH, rewardError);
  if (actorId === null && actorLabel === null) {
    throw rewardError('actor must carry an id or a label — the applying party must be traceable');
  }

  const rationale = optionalTrimmed(input.rationale, 'rationale', MAX_RATIONALE_LENGTH, rewardError);

  return { contribution: { kind, id, label, contributor }, missionId, value, actor: { kind: actorKind, id: actorId, label: actorLabel }, rationale };
}

// ---------------------------------------------------------------------------
// Settlement + query inputs
// ---------------------------------------------------------------------------

/** Fully validated + normalized `settleReward` input. */
export interface ValidatedSettleInput {
  rewardId: string;
}

export function validateSettleRewardInput(input: unknown): ValidatedSettleInput {
  if (!isPlainObject(input)) {
    throw new RewardsError('invalid_settlement_input', 'settlement input must be an object');
  }
  rejectUnknownKeys(input, SETTLE_INPUT_KEYS, 'settlement input', (message) =>
    new RewardsError('invalid_settlement_input', message),
  );
  return {
    rewardId: requireUuid(input.rewardId, 'rewardId', (message) =>
      new RewardsError('invalid_settlement_input', message),
    ),
  };
}

/** Fully validated + normalized `listRewards` query. */
export interface ValidatedListQuery {
  missionId: string | null;
  contributorPersonId: string | null;
  status: RewardStatus | null;
  kind: RewardKind | null;
  limit: number;
}

export function validateListRewardsQuery(query: ListRewardsQuery): ValidatedListQuery {
  if (!isPlainObject(query)) throw queryError('list query must be an object');
  rejectUnknownKeys(query, LIST_QUERY_KEYS, 'list query', queryError);
  const missionId =
    query.missionId === undefined || query.missionId === null
      ? null
      : requireUuid(query.missionId, 'missionId', queryError);
  const contributorPersonId =
    query.contributorPersonId === undefined || query.contributorPersonId === null
      ? null
      : requireUuid(query.contributorPersonId, 'contributorPersonId', queryError);
  const status =
    query.status === undefined || query.status === null ? null : query.status;
  if (status !== null && !isRewardStatus(status)) {
    throw queryError(
      `status must be one of ${REWARD_STATUSES.join(', ')} (got '${String(query.status)}')`,
    );
  }
  const kind = query.kind === undefined || query.kind === null ? null : query.kind;
  if (kind !== null && !isRewardKind(kind)) {
    throw queryError(`kind must be one of ${REWARD_KINDS.join(', ')} (got '${String(query.kind)}')`);
  }
  const limitRaw = query.limit ?? DEFAULT_LIST_LIMIT;
  if (typeof limitRaw !== 'number' || !Number.isInteger(limitRaw) || limitRaw < 1 || limitRaw > MAX_LIST_LIMIT) {
    throw queryError(`limit must be an integer in [1, ${MAX_LIST_LIMIT}] (got ${String(limitRaw)})`);
  }
  return { missionId, contributorPersonId, status, kind, limit: limitRaw };
}

/** Fully validated + normalized `summarizeRewards` query. */
export interface ValidatedSummarizeQuery {
  missionId: string | null;
  contributorPersonId: string | null;
}

export function validateSummarizeRewardsQuery(query: unknown): ValidatedSummarizeQuery {
  if (!isPlainObject(query)) throw queryError('summarize query must be an object');
  rejectUnknownKeys(query, SUMMARIZE_QUERY_KEYS, 'summarize query', queryError);
  const missionId =
    query.missionId === undefined || query.missionId === null
      ? null
      : requireUuid(query.missionId, 'missionId', queryError);
  const contributorPersonId =
    query.contributorPersonId === undefined || query.contributorPersonId === null
      ? null
      : requireUuid(query.contributorPersonId, 'contributorPersonId', queryError);
  return { missionId, contributorPersonId };
}

// ---------------------------------------------------------------------------
// The deterministic policy evaluation (W043's core, pure)
// ---------------------------------------------------------------------------

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/**
 * The structural policy shape `evaluateRewardPolicy` consumes — satisfied
 * by the stored `RewardPolicy` and by `ValidatedPolicyInput` alike, so the
 * definition is testable without a database.
 */
export interface RewardPolicyEvaluationShape {
  qualifyingStatuses: readonly ContributionStatus[];
  minKnowledgeGain: number;
  minAffectedGoals: number;
  weights: {
    knowledgeGain: number;
    missionImpact: number;
    costAvoided: number;
  };
  impactKindWeights: {
    advanced: number;
    resolved: number;
    no_effect: number;
  };
  costAvoidedSaturation: number;
  tiers: readonly RewardTier[];
  rewardCurrency: string;
}

/**
 * THE deterministic conversion of contribution value into a configured
 * reward (§8 "RewardPolicy converts contribution value into configured
 * rewards"). Pure function of (policy, value):
 *
 *  1. currency guard — the assessed cost-avoided figure must be
 *     denominated in the policy's reward currency (no conversion exists);
 *  2. eligibility gates, in fixed order (the first failure is the recorded
 *     reason): qualifying status → minimum knowledge gain → minimum
 *     affected goals;
 *  3. the three §8 factors: knowledge gain as-is; the policy's
 *     impact-kind weight; cost avoided scaled linearly against the
 *     saturation point, capped at 1;
 *  4. the composite value score: the weighted sum of the factors,
 *     saturated at 1, rounded to 6 decimals;
 *  5. the matched tier: the HIGHEST floor ≤ valueScore (tiers are stored
 *     ascending); no matching floor ⇒ no reward is due.
 *
 * The reward itself (kind, amount, currency) comes ONLY from the matched
 * tier — the caller can never configure or forge it per application.
 */
export function evaluateRewardPolicy(
  policy: RewardPolicyEvaluationShape,
  value: ValidatedContributionValue,
): RewardPolicyAssessment {
  if (value.costAvoided.currency !== policy.rewardCurrency) {
    throw new RewardsError(
      'currency_mismatch',
      `the assessed investigation cost avoided is denominated in '${value.costAvoided.currency}' but the reward policy converts in '${policy.rewardCurrency}' — no cross-currency conversion exists`,
    );
  }

  const components = {
    knowledgeGain: value.knowledgeGain,
    missionImpact: value.missionImpact,
    affectedGoalCount: value.affectedGoals.length,
    costAvoided: { ...value.costAvoided },
  };

  const base: RewardPolicyAssessment = {
    decision: 'no_reward_due',
    reason: null,
    status: value.status,
    components,
    factors: { knowledgeGain: 0, missionImpact: 0, costAvoided: 0 },
    valueScore: 0,
    tier: null,
  };

  // 2. Eligibility, fixed order — the first failing gate is the reason.
  if (!policy.qualifyingStatuses.includes(value.status)) {
    return { ...base, reason: 'non_qualifying_status' };
  }
  if (value.knowledgeGain < policy.minKnowledgeGain) {
    return { ...base, reason: 'knowledge_gain_below_minimum' };
  }
  if (value.affectedGoals.length < policy.minAffectedGoals) {
    return { ...base, reason: 'insufficient_goal_impact' };
  }

  // 3. The §8 factors.
  const factors = {
    knowledgeGain: value.knowledgeGain,
    missionImpact: policy.impactKindWeights[value.missionImpact],
    costAvoided: Math.min(1, value.costAvoided.amount / policy.costAvoidedSaturation),
  };

  // 4. The composite score.
  const valueScore = round6(
    Math.min(
      1,
      policy.weights.knowledgeGain * factors.knowledgeGain +
        policy.weights.missionImpact * factors.missionImpact +
        policy.weights.costAvoided * factors.costAvoided,
    ),
  );

  // 5. The matched tier — highest floor ≤ score (tiers ascending).
  let matched: RewardTier | null = null;
  for (const tier of policy.tiers) {
    if (valueScore >= tier.minValueScore) matched = tier;
  }
  if (matched === null) {
    return { ...base, factors, valueScore, reason: 'below_tier_floor' };
  }

  return {
    decision: 'reward_due',
    reason: null,
    status: value.status,
    components,
    factors,
    valueScore,
    tier: {
      name: matched.name,
      minValueScore: matched.minValueScore,
      kind: matched.kind,
      amount: matched.amount,
      currency: policy.rewardCurrency,
    },
  };
}

/**
 * The snapshot of the policy frozen on one reward row — the policy exactly
 * as it decided, plus the matched tier's floor.
 */
export function snapshotPolicy(
  policy: RewardPolicy,
  matchedTier: RewardTier,
): RewardPolicySnapshot {
  return {
    version: policy.version,
    qualifyingStatuses: [...policy.qualifyingStatuses],
    minKnowledgeGain: policy.minKnowledgeGain,
    minAffectedGoals: policy.minAffectedGoals,
    weights: { ...policy.weights },
    impactKindWeights: { ...policy.impactKindWeights },
    costAvoidedSaturation: policy.costAvoidedSaturation,
    rewardCurrency: policy.rewardCurrency,
    matchedTierFloor: matchedTier.minValueScore,
  };
}

// ---------------------------------------------------------------------------
// Status derivations (pure)
// ---------------------------------------------------------------------------

/**
 * The status a reward is minted with, mapped from the action request the
 * grant was routed through: policy-allowed → 'granted' (auto-approved by
 * the matrix), gated → 'proposed' (waits for the human decision),
 * policy-forbidden → 'refused' (recorded evidence of the refusal).
 */
export function mintedStatusForRequestStatus(
  requestStatus: 'pending' | 'approved' | 'rejected',
): 'proposed' | 'granted' | 'refused' {
  switch (requestStatus) {
    case 'approved':
      return 'granted';
    case 'pending':
      return 'proposed';
    case 'rejected':
      return 'refused';
  }
}

/**
 * The DERIVED current status of one reward: a settlement always wins over
 * the minted status (only gated rewards can settle); without one, the
 * minted status stands.
 */
export function derivedRewardStatus(
  mintedStatus: 'proposed' | 'granted' | 'refused',
  settlement: { decision: SettlementDecision } | null,
): RewardStatus {
  if (settlement !== null) return settlement.decision;
  return mintedStatus;
}

/**
 * The authority outcome ⇒ minted status mapping (the pure half of the §20
 * wiring; `authorizeAction` supplies the evaluated request).
 */
export function mintedStatusForOutcome(outcome: AuthorityOutcome): 'proposed' | 'granted' | 'refused' {
  switch (outcome) {
    case 'allowed':
      return 'granted';
    case 'approval_required':
      return 'proposed';
    case 'forbidden':
      return 'refused';
  }
}
