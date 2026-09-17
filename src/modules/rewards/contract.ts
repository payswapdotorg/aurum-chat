// ============================================================================
// rewards — the ONLY public surface of the rewards module
// (IMPLEMENTATION-STACK §2; cross-module imports of anything else are
// architecture violations detected by scripts/check-architecture.ts).
//
// W043 — Rewards:
// "Apply explicit reward policies to valuable knowledge contributions.
//  Rewards are separate from compensation/performance decisions."
//
// ARCHITECTURE.md §8 (frozen): "KnowledgeContribution records what
// information an employee supplied, the associated evidence, validation
// outcome, knowledge gain, goal impact and investigation cost avoided.
// RewardPolicy converts contribution value into configured rewards." And:
// "Rewards must never silently become compensation decisions or
// performance ratings. Contribution rewards are a separate policy-
// controlled mechanism." Lock 9: "Employees are first-class knowledge
// sources; useful knowledge contributions may be rewarded under explicit
// policy."
//
//   setRewardPolicy / getRewardPolicy — the tenant's ONE explicit
//      conversion policy: eligibility gates (qualifying validation
//      statuses, minimum knowledge gain, minimum affected goals), the
//      three §8 value-component weights, per-impact-kind weights, the
//      cost-avoided saturation point and the ordered reward tiers.
//      Claim-gated ('rewards:administer'); versioned; deliberately
//      updatable like the actions module's authority policies (a
//      management control — change history belongs to audit, W046). NO
//      default policy exists: rewards are granted only under an EXPLICIT
//      policy (`policy_not_configured`), which is lock 9's "under
//      explicit policy" made structural.
//   applyRewardPolicy — the core: validate the contribution anchor,
//      read the mission whose reward budget governs (W011), run the PURE
//      deterministic conversion (`evaluateRewardPolicy`), and — when a
//      reward is due — route the grant through the actions module's
//      uniform §20 authority gate ('contribution-reward' at EXECUTE; the
//      built-in floor approval-gates it, so by default every reward waits
//      for an explicit human decision unless the tenant relaxed its
//      matrix), then commit ONE append-only reward row under a
//      per-contribution advisory lock with the budget re-checked. The
//      reward (kind, amount, currency) comes ONLY from the matched tier —
//      the caller supplies the §8 value assessment, never the reward. No
//      reward due ⇒ the full deterministic rationale is returned and
//      NOTHING is recorded.
//   settleReward — the one-way 'proposed' → terminal transition of a
//      gated reward: consumes the actions module's FROZEN human decision
//      on the reward's action request (never a re-derivation) and appends
//      the single terminal settlement ('granted' / 'declined'; first
//      write wins).
//   getReward / listRewards / summarizeRewards — the derived current
//      views (settlement wins over the minted status), filtered by
//      mission, contributing employee, status and kind, plus the status/
//      kind/currency rollup with the budget-committed totals.
//
// There is deliberately NO operation to rewrite a reward, un-settle,
// un-refuse or delete anything, and NO operation that writes a reward
// outside the evaluated policy: what a policy decided, what it
// configured, what budget it committed and how the authority gate
// resolved are append-only history — PostgreSQL itself rejects
// UPDATE/DELETE/TRUNCATE on rewards and reward_settlements (migration 001
// triggers). A changed conversion is a NEW policy version applied to
// FUTURE contributions; recorded rewards keep the snapshot of the version
// that decided them.
//
// COMPENSATION SEPARATION (the item's second sentence, structural): the
// reward-kind vocabulary is closed to non-compensation shapes
// (recognition/gift/voucher/experience/donation — COMPENSATION_EXCLUDED_
// KINDS documents the excluded set and tests pin the disjointness), the
// storage CHECK rejects compensation kinds outright, and no compensation
// or performance field exists on any input, row or read model. A reward
// recognizes a knowledge contribution; it is never a compensation
// decision and never a performance rating.
//
// Tenancy (ADR-0001): every operation takes an explicit TenantContext
// and is tenant-scoped at the SQL layer; access to another tenant's
// rewards or settlements (including settling by foreign-tenant reward id)
// is reported as `reward_not_found` — no existence leak. The
// acquisition-plan anchor is uniformly `invalid_contribution_ref` for
// missing, malformed, foreign-tenant and non-answer plans alike, and a
// foreign-tenant mission reads as `mission_not_found`.
//
// Dependency posture (WORK-ITEM-DEPENDENCY-GRAPH.md: W042 + W009 → W043):
// the actions contract (W009, delivered) is the load-bearing dependency —
// every computed grant is authorized through its uniform approval gate
// and every gated reward is settled by consuming its frozen decision.
// The missions contract (W011, delivered) supplies the reward budget and
// reward terms that bound and contextualize rewards (its types.ts states
// rewardTerms is "what is promised for a qualifying contribution, when
// stated (§8/W043 reads this)"). The knowledge-acquisition contract
// (W012, delivered; the MODULE-DEPENDENCY-MAP chain knowledge-acquisition
// → learning → rewards) validates the answered ask-person plan a
// contribution anchors to and supplies the derived contributing employee
// — the same anchor the contributions module builds on. The declared W042
// (contributions) dependency is NOT present in repository state at this
// base: the §8 value assessment therefore enters as EXPLICIT caller input
// anchored to a contribution reference — 'acquisition-plan' (validated
// readable through the W012 contract at write time) or
// 'knowledge-contribution' (an opaque forward reference to a W042 record:
// the merge-time wiring surface, exactly like the missions module's
// opaque goal references). No dependency contract was consumed for the
// value assessment itself, so no escalation is required; the gap is
// reported under DEVIATIONS in the delivery report. The people module
// (W002) is verified present but not imported: contributor references
// are derived from validated plans or opaque forward references, which
// the contributions module verifies at ITS write time when it lands.
// ============================================================================

export {
  applyRewardPolicy,
  getReward,
  getRewardPolicy,
  listRewards,
  setRewardPolicy,
  settleReward,
  summarizeRewards,
} from './service';

export { RewardsError } from './errors';
export type { RewardsErrorCode } from './errors';

// The deterministic conversion — the single pure definition of W043's
// core ("RewardPolicy converts contribution value into configured
// rewards"), exported for verification and reuse by downstream surfaces
// (W053 CompanyModel consumes the FROZEN records this produces).
export {
  evaluateRewardPolicy,
  mintedStatusForOutcome,
  mintedStatusForRequestStatus,
  derivedRewardStatus,
  snapshotPolicy,
} from './validation';
export type {
  RewardPolicyEvaluationShape,
  ValidatedApplyInput,
  ValidatedContributionValue,
  ValidatedListQuery,
  ValidatedPolicyInput,
  ValidatedSettleInput,
  ValidatedSummarizeQuery,
} from './validation';

// Wiring constants (the §20 policy integration points).
export {
  REWARD_ACTION_KIND,
  REWARD_AUTHORITY_LEVEL,
  REWARDS_AUTHORITY_ADMINISTER,
  canAdministerRewards,
} from './validation';

// Vocabularies, guards and caps (mirrored by the CHECK constraints in
// migrations/001-rewards.sql).
export {
  COMPENSATION_EXCLUDED_KINDS,
  CONTRIBUTION_REF_KINDS,
  CONTRIBUTION_STATUSES,
  DEFAULT_LIST_LIMIT,
  MAX_AFFECTED_GOALS,
  MAX_AMOUNT,
  MAX_LABEL_LENGTH,
  MAX_LIST_LIMIT,
  MAX_NOTE_LENGTH,
  MAX_RATIONALE_LENGTH,
  MAX_TIER_NAME_LENGTH,
  MAX_TIERS,
  MISSION_IMPACT_KINDS,
  REWARD_KINDS,
  REWARD_PARTY_KINDS,
  REWARD_STATUSES,
  SETTLEMENT_DECISIONS,
  isContributionRefKind,
  isContributionStatus,
  isMissionImpactKind,
  isRewardKind,
  isRewardPartyKind,
  isRewardStatus,
  isSettlementDecision,
  isUuid,
} from './validation';

export type {
  ApplyRewardPolicyInput,
  ContributionContributor,
  ContributionContributorInput,
  ContributionRefKind,
  ContributionStatus,
  ContributionValue,
  ListRewardsQuery,
  MissionImpactKind,
  PersistedContributionValue,
  Reward,
  RewardActor,
  RewardApplicationResult,
  RewardCommittedRollup,
  RewardGoalRef,
  RewardGoalRefInput,
  RewardKind,
  RewardKindRollup,
  RewardParty,
  RewardPartyInput,
  RewardPartyKind,
  RewardPolicy,
  RewardPolicyAssessment,
  RewardPolicySnapshot,
  RewardSettlement,
  RewardStatus,
  RewardStatusCounts,
  RewardSummary,
  RewardTier,
  RewardTierInput,
  SetRewardPolicyInput,
  SettleRewardInput,
  SettlementDecision,
  SummarizeRewardsQuery,
} from './types';
