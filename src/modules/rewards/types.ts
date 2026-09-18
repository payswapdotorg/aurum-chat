// Public domain types of the rewards module (W043 — Rewards).
//
// W043: "Apply explicit reward policies to valuable knowledge
// contributions. Rewards are separate from compensation/performance
// decisions."
//
// ARCHITECTURE.md §8 (frozen): "KnowledgeContribution records what
// information an employee supplied, the associated evidence, validation
// outcome, knowledge gain, goal impact and investigation cost avoided.
// RewardPolicy converts contribution value into configured rewards." And:
// "Rewards must never silently become compensation decisions or performance
// ratings. Contribution rewards are a separate policy-controlled
// mechanism." Lock 9: "Employees are first-class knowledge sources; useful
// knowledge contributions may be rewarded under explicit policy."
//
// Three concepts, one flow:
//
//  1. THE VALUE ASSESSMENT (what is being rewarded): the §8 contribution
//     value dimensions — validation status (the contributions module's
//     derived ladder), knowledge gain, mission impact, affected goals and
//     investigation cost avoided — supplied EXPLICITLY by the caller on
//     apply (see the W042 note in contract.ts: the contributions module is
//     not present at this base, so the assessment enters as caller input
//     anchored to an opaque contribution reference).
//
//  2. THE REWARD POLICY (the explicit conversion): a tenant-scoped
//     management control — eligibility gates (qualifying validation
//     statuses, minimum knowledge gain, minimum affected goals), the three
//     §8 value-component weights, per-impact-kind weights, the cost-avoided
//     saturation point, and the ordered reward tiers. Deliberately NO
//     default policy exists: rewards are granted only under an EXPLICIT
//     policy (`policy_not_configured` until the tenant configures one),
//     mirroring "may be rewarded under explicit policy" (lock 9).
//
//  3. THE REWARD (the configured outcome): one append-only record per
//     contribution, minted by the service from the matched tier — the
//     caller NEVER supplies a reward kind or amount — carrying the value
//     snapshot, the policy snapshot, the mission reward-budget accounting
//     and the authority-gate evaluation, plus an append-only settlement
//     record when a gated (proposed) reward is later granted or declined by
//     the recorded human decision.
//
// COMPENSATION SEPARATION (the item's second sentence, structurally
// enforced): the reward-kind vocabulary is closed to non-compensation kinds
// ('recognition' | 'gift' | 'voucher' | 'experience' | 'donation'); no
// salary/bonus/commission/raise/promotion kind exists, no compensation or
// performance field exists anywhere in this module's inputs, rows or read
// models, and the SQL CHECK constraints reject compensation-shaped kinds at
// the storage layer. A reward recognizes a knowledge contribution; it is
// never a compensation decision and never a performance rating.

import type { AuthorityOutcome, PolicyResolutionSource } from '@/modules/actions/contract';

// ---------------------------------------------------------------------------
// Vocabularies (mirrored by CHECK constraints in migrations/001)
// ---------------------------------------------------------------------------

/**
 * The closed vocabulary of configured reward kinds. Deliberately excludes
 * every compensation/performance shape (no salary, bonus, commission,
 * raise, promotion, merit increase, performance rating): rewards are a
 * separate policy-controlled mechanism (§8), so the vocabulary itself makes
 * a compensation decision unrepresentable here. COMPENSATION_EXCLUDED_KINDS
 * (validation.ts) documents the excluded set and the disjointness is
 * tested.
 */
export type RewardKind = 'recognition' | 'gift' | 'voucher' | 'experience' | 'donation';

/**
 * What kind of record the rewarded contribution is anchored to:
 *  * 'acquisition-plan'        — an answered ask-person acquisition plan
 *    (W012, delivered): the plan is validated readable through the
 *    knowledge-acquisition contract at write time and the contributing
 *    employee + mission are DERIVED from it;
 *  * 'knowledge-contribution'  — a knowledge contribution record owned by
 *    the contributions module (W042, NOT present at this base): an opaque
 *    forward reference — the merge-time wiring surface, exactly like the
 *    missions module's opaque goal references.
 */
export type ContributionRefKind = 'acquisition-plan' | 'knowledge-contribution';

/**
 * The contribution's current validation status — the contributions
 * module's (W042) derived status ladder, mirrored here because the value
 * assessment is caller-supplied at this base:
 *  * 'pending'      — recorded, not yet assessed;
 *  * 'validated'    — the current validation supports the information;
 *  * 'contradicted' — other evidence contradicts it (retained, lock 12);
 *  * 'rejected'     — validation did not support it;
 *  * 'measured'     — validated AND impact-measured (the valuable case).
 */
export type ContributionStatus =
  | 'pending'
  | 'validated'
  | 'contradicted'
  | 'rejected'
  | 'measured';

/**
 * What the contribution did to the mission it served (§8 "goal impact" /
 * the catalog's "mission impact") — the contributions module's (W042)
 * vocabulary, mirrored for the caller-supplied value assessment.
 */
export type MissionImpactKind = 'advanced' | 'resolved' | 'no_effect';

/**
 * The lifecycle of one reward:
 *  * 'proposed' — minted: the authority gate requires a human decision
 *    (approval-gated EXECUTE; the reward commits budget and waits);
 *  * 'granted'  — minted (the matrix allowed the grant outright) or
 *    settled (the gated reward's action request was approved);
 *  * 'declined' — settled: the gated reward's action request was rejected;
 *  * 'refused'  — minted: the tenant's authority policy forbids rewarding
 *    contributions outright (recorded as evidence of the refusal).
 * 'granted', 'declined' and 'refused' are terminal; only a 'proposed'
 * reward can move, and only forward, via its one settlement record.
 */
export type RewardStatus = 'proposed' | 'granted' | 'declined' | 'refused';

/** The terminal decision recorded on one gated reward's settlement. */
export type SettlementDecision = 'granted' | 'declined';

/** Kinds of parties that can apply policies or settle rewards. */
export type RewardPartyKind = 'person' | 'team' | 'agent' | 'system' | 'external';

// ---------------------------------------------------------------------------
// Contribution value (the §8 assessment input)
// ---------------------------------------------------------------------------

/**
 * One affected-goal reference (the missions module's precedent): an opaque
 * uuid forward reference to a goals module (W008) record plus an optional
 * human label. §8 "goal impact": which goals felt the contribution.
 */
export interface RewardGoalRef {
  goalId: string;
  label?: string | null;
}

/** Input shape of `RewardGoalRef`. */
export interface RewardGoalRefInput {
  goalId: string;
  label?: string | null;
}

/**
 * The contributing employee: an opaque uuid forward reference to a people
 * module (W002) person record plus an optional human label. For an
 * 'acquisition-plan' anchor the service DERIVES this from the validated
 * plan (the planner resolved the person when it planned the ask); for a
 * 'knowledge-contribution' reference the caller supplies it — the
 * contributions module (W042) owns contributor verification at record time.
 */
export interface ContributionContributor {
  personId: string;
  label?: string | null;
}

/** Input shape of `ContributionContributor`. */
export interface ContributionContributorInput {
  personId: string;
  label?: string | null;
}

/**
 * The §8 contribution VALUE, explicitly supplied by the caller at apply
 * time: the validation status, the knowledge gain (mission confidence
 * delta), the mission impact, the affected goals and the investigation
 * cost avoided (integer minor units). The policy's job is to convert THIS
 * into a configured reward (validation.ts `evaluateRewardPolicy` is the
 * single deterministic definition).
 */
export interface ContributionValue {
  /** The contribution's current validation status (the W042 ladder). */
  status: ContributionStatus;
  /** Mission confidence gained from the contribution, [0, 1]. */
  knowledgeGain: number;
  /** What the contribution did to the mission it served. */
  missionImpact: MissionImpactKind;
  /** Goals that felt the impact (opaque forward references, ≤ 16). */
  affectedGoals: RewardGoalRefInput[];
  /**
   * Investigation cost avoided: integer MINOR UNITS of `currency`. Must be
   * denominated in the policy's reward currency — the stack performs no
   * cross-currency conversion (the knowledge-acquisition precedent), so a
   * mismatch is a uniform `currency_mismatch`.
   */
  costAvoided: {
    amount: number;
    currency: string;
  };
}

/** The persisted snapshot of one `ContributionValue` (labels normalized). */
export interface PersistedContributionValue {
  status: ContributionStatus;
  knowledgeGain: number;
  missionImpact: MissionImpactKind;
  affectedGoals: RewardGoalRef[];
  costAvoided: {
    amount: number;
    currency: string;
  };
}

// ---------------------------------------------------------------------------
// The reward policy (the explicit conversion)
// ---------------------------------------------------------------------------

/** One configured reward tier of a reward policy. */
export interface RewardTier {
  /** Short human name, e.g. 'thank-you-gift'. */
  name: string;
  /** The minimum value score (inclusive) this tier matches, [0, 1]. */
  minValueScore: number;
  /** The configured reward kind (non-compensation vocabulary only). */
  kind: RewardKind;
  /** The configured amount in MINOR UNITS of the policy currency (0 = pure recognition). */
  amount: number;
}

/** Input shape of `RewardTier`. */
export interface RewardTierInput {
  name: string;
  minValueScore: number;
  kind: RewardKind;
  amount: number;
}

/**
 * The tenant's explicit reward policy — the management control that
 * converts contribution value into configured rewards (§8 "RewardPolicy").
 *
 * Deliberately updatable, NOT append-only: like the actions module's
 * authority policies, a reward policy is a management control whose change
 * history belongs to the audit module (W046); every reward row snapshots
 * the policy exactly as it decided (`policySnapshot`), so later edits never
 * rewrite what rewarded a recorded contribution. Writing it requires the
 * 'rewards:administer' authority claim.
 */
export interface RewardPolicy {
  /** 1-based, incremented on every update. */
  version: number;
  /** Contribution statuses that may be rewarded (default: validated, measured). */
  qualifyingStatuses: ContributionStatus[];
  /** Minimum knowledge gain for eligibility, [0, 1]. */
  minKnowledgeGain: number;
  /** Minimum affected-goal count for eligibility (§8 goal-impact gate). */
  minAffectedGoals: number;
  /** The three §8 value-component weights, each [0, 1]. */
  weights: {
    knowledgeGain: number;
    missionImpact: number;
    costAvoided: number;
  };
  /** The impact factor per mission-impact kind, each [0, 1]. */
  impactKindWeights: {
    advanced: number;
    resolved: number;
    no_effect: number;
  };
  /**
   * The investigation-cost-avoided amount (minor units) at which the
   * cost-avoided factor saturates at 1 — the linear scale point.
   */
  costAvoidedSaturation: number;
  /** The reward tiers, ascending by minValueScore; the HIGHEST matching floor wins. */
  tiers: RewardTier[];
  /**
   * The single currency of this policy's reward flow. The mission's reward
   * budget and the assessed cost-avoided figure must share it
   * (`currency_mismatch` otherwise — no conversion exists).
   */
  rewardCurrency: string;
  note: string | null;
  /** The authenticated TenantContext principal that last wrote the policy. */
  updatedByPrincipal: string;
  /** ISO 8601 — when version 1 was committed. */
  createdAt: string;
  /** ISO 8601 — when this version was committed. */
  updatedAt: string;
}

/** Input shape of `setRewardPolicy` (version/principal/timestamps minted). */
export interface SetRewardPolicyInput {
  qualifyingStatuses?: ContributionStatus[];
  minKnowledgeGain?: number;
  minAffectedGoals?: number;
  weights?: {
    knowledgeGain?: number;
    missionImpact?: number;
    costAvoided?: number;
  };
  impactKindWeights?: {
    advanced?: number;
    resolved?: number;
    no_effect?: number;
  };
  costAvoidedSaturation?: number;
  tiers: RewardTierInput[];
  rewardCurrency: string;
  note?: string | null;
}

/**
 * The policy snapshot frozen on one reward row — the policy exactly as it
 * decided (plus the matched tier's floor), so a reward is reconstructable
 * even after later policy edits.
 */
export interface RewardPolicySnapshot {
  version: number;
  qualifyingStatuses: ContributionStatus[];
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
  rewardCurrency: string;
  /** The matched tier's minimum value score. */
  matchedTierFloor: number;
}

// ---------------------------------------------------------------------------
// The deterministic assessment (pure evaluation result)
// ---------------------------------------------------------------------------

/**
 * The deterministic result of evaluating one reward policy against one
 * contribution value — what `evaluateRewardPolicy` (validation.ts, the
 * single pure definition) returns and what `applyRewardPolicy` persists on
 * the reward row as its computation rationale. Same policy + same value ⇒
 * same assessment, always (no clock, no randomness, no IO).
 */
export interface RewardPolicyAssessment {
  /** Whether the policy configures a reward for this value. */
  decision: 'reward_due' | 'no_reward_due';
  /**
   * Why no reward is due ('no_reward_due' only): the FIRST failing gate in
   * the fixed order status → knowledge gain → goal impact → tier floor.
   */
  reason: 'non_qualifying_status' | 'knowledge_gain_below_minimum' | 'insufficient_goal_impact' | 'below_tier_floor' | null;
  /** The assessed contribution status (snapshot). */
  status: ContributionStatus;
  /** The §8 value components, separately represented (snapshot). */
  components: {
    knowledgeGain: number;
    missionImpact: MissionImpactKind;
    affectedGoalCount: number;
    costAvoided: {
      amount: number;
      currency: string;
    };
  };
  /** The deterministic [0, 1] factors the score weighed. */
  factors: {
    knowledgeGain: number;
    missionImpact: number;
    costAvoided: number;
  };
  /** The composite value score, [0, 1], rounded to 6 decimals. */
  valueScore: number;
  /** The matched tier with its configured reward ('reward_due' only). */
  tier: {
    name: string;
    /** The tier's minimum value score (inclusive) — the matched floor. */
    minValueScore: number;
    kind: RewardKind;
    amount: number;
    currency: string;
  } | null;
}

// ---------------------------------------------------------------------------
// apply / settle inputs
// ---------------------------------------------------------------------------

/**
 * A provider-neutral party reference (lock 16): an opaque uuid `id` owned
 * by the respective module and/or a human-readable `label`. At least one
 * must be present — the party must be traceable (the missions actor rule).
 */
export interface RewardParty {
  kind: RewardPartyKind;
  id?: string | null;
  label?: string | null;
}

/** Input shape of `RewardParty`. */
export interface RewardPartyInput {
  kind: RewardPartyKind;
  id?: string | null;
  label?: string | null;
}

/** The party that applies a reward policy (`RewardParty`). */
export type RewardActor = RewardParty;

/**
 * Input shape of `applyRewardPolicy`. The contribution anchor and the §8
 * value assessment are the essentials; the contributing employee and the
 * mission are DERIVED for an 'acquisition-plan' anchor and supplied by the
 * caller for a 'knowledge-contribution' reference.
 */
export interface ApplyRewardPolicyInput {
  contribution: {
    kind: ContributionRefKind;
    id: string;
    /** Optional human label for the anchored record. */
    label?: string | null;
    /**
     * The contributing employee. REQUIRED for a 'knowledge-contribution'
     * reference (the caller reads it off the contribution record);
     * FORBIDDEN for an 'acquisition-plan' anchor — the service derives it
     * from the validated plan and never trusts a caller-supplied one.
     */
    contributor?: ContributionContributorInput | null;
  };
  /**
   * The mission whose reward budget governs. REQUIRED for a
   * 'knowledge-contribution' reference; optional for an 'acquisition-plan'
   * anchor (derived from the plan) and, when supplied, must MATCH the
   * plan's mission.
   */
  missionId?: string | null;
  /** The §8 contribution value assessment. */
  value: ContributionValue;
  /** Who/what is applying the policy (audit trail). */
  actor: RewardPartyInput;
  /** Why now — optional, recorded on the reward. */
  rationale?: string | null;
}

/** Input shape of `settleReward`. */
export interface SettleRewardInput {
  rewardId: string;
}

// ---------------------------------------------------------------------------
// Read models
// ---------------------------------------------------------------------------

/**
 * The terminal settlement of one gated reward — the frozen consumption of
 * the actions module's human decision on the reward's action request.
 * First write wins; there is no un-settle.
 */
export interface RewardSettlement {
  rewardId: string;
  decision: SettlementDecision;
  /**
   * The principal that decided the underlying action request (from its
   * approval-decision trail); null only if the trail row is somehow
   * absent — the decision time still comes from the request itself.
   */
  decidedByPrincipal: string | null;
  /** When the authority decision landed (the request's decidedAt). */
  decidedAt: string | null;
  /** The authenticated TenantContext principal that recorded the settlement. */
  settledByPrincipal: string;
  /** ISO 8601 — when the settlement was committed (service clock). */
  settledAt: string;
}

/**
 * One reward — the append-only record of ONE configured reward for ONE
 * knowledge contribution: the value assessment it rewarded, the policy
 * snapshot that decided, the mission reward-budget accounting that bounded
 * it, the authority evaluation that gated it, and (for gated rewards) the
 * settlement that completed it.
 */
export interface Reward {
  id: string;
  tenantId: string;
  /** The rewarded contribution (opaque/validated forward reference). */
  contribution: {
    kind: ContributionRefKind;
    id: string;
    label: string | null;
  };
  /** The contributing employee the reward goes to. */
  contributor: ContributionContributor;
  /** The mission whose reward budget governed (opaque forward reference). */
  missionId: string;
  /** The mission version whose reward budget was read. */
  missionVersion: number;
  /** The mission's reward budget as it governed (minor units + currency). */
  missionRewardBudget: {
    amount: number;
    currency: string;
  };
  /** What the mission promised for a qualifying contribution, when stated. */
  missionRewardTerms: string | null;
  /** The §8 value assessment this reward rewarded (frozen snapshot). */
  value: PersistedContributionValue;
  /** The persisted evaluation rationale (factors, score, matched tier). */
  assessment: RewardPolicyAssessment;
  /** The composite value score (also on `assessment`). */
  valueScore: number;
  /** The configured reward the matched tier granted. */
  tier: {
    name: string;
    /** The matched tier's minimum value score. */
    minValueScore: number;
    kind: RewardKind;
    amount: number;
    currency: string;
  };
  /** The policy version that decided. */
  policyVersion: number;
  /** The policy exactly as it decided (frozen snapshot). */
  policySnapshot: RewardPolicySnapshot;
  /** The DERIVED current status (settlement wins over the minted status). */
  status: RewardStatus;
  /** The actions-module authority evaluation that gated the grant. */
  authority: {
    outcome: AuthorityOutcome;
    resolvedVia: PolicyResolutionSource;
  };
  /** The action request the grant was routed through (§20 gate). */
  actionRequestId: string;
  /** Mission reward budget remaining BEFORE this reward's commitment. */
  budgetRemainingBefore: number;
  /** Who/what applied the policy (audit trail). */
  actor: RewardActor;
  /** The authenticated TenantContext principal that committed the reward. */
  appliedByPrincipal: string;
  rationale: string | null;
  /** ISO 8601 — when the reward was committed (service clock). */
  recordedAt: string;
  /** The settlement, once a gated reward was decided. */
  settlement: RewardSettlement | null;
}

/** Query shape of `listRewards`. */
export interface ListRewardsQuery {
  missionId?: string;
  contributorPersonId?: string;
  status?: RewardStatus;
  kind?: RewardKind;
  /** 1..500, default 50. */
  limit?: number;
}

/** Query shape of `summarizeRewards`. */
export interface SummarizeRewardsQuery {
  missionId?: string;
  contributorPersonId?: string;
}

/** Per-(status) counts of the summarized reward set. */
export interface RewardStatusCounts {
  proposed: number;
  granted: number;
  declined: number;
  refused: number;
}

/** One per-kind rollup row. */
export interface RewardKindRollup {
  kind: RewardKind;
  currency: string;
  count: number;
  amount: number;
}

/** One per-currency committed rollup row (granted + proposed). */
export interface RewardCommittedRollup {
  currency: string;
  count: number;
  amount: number;
}

/** The reward rollup of `summarizeRewards`. */
export interface RewardSummary {
  /** Total rewards in the summarized set (every status). */
  totalRewards: number;
  byStatus: RewardStatusCounts;
  byKind: RewardKindRollup[];
  /** Budget-committed rewards (granted + proposed) per currency. */
  committedByCurrency: RewardCommittedRollup[];
  /** Distinct contributing employees in the set. */
  contributors: number;
}

/** Result of `applyRewardPolicy`: the assessment plus the minted reward. */
export interface RewardApplicationResult {
  assessment: RewardPolicyAssessment;
  /** Null exactly when no reward is due (nothing was recorded). */
  reward: Reward | null;
}
