// Learning missions, contributions & rewards (W062) — the view builders.
//
// Server-side composition of EXISTING module contracts only (lock 31/32:
// contracts, never persistence) — the same discipline the intelligence
// and marketplace surfaces follow. The three views:
//
//   buildLearningHomeView   — the Learning hub: the OPEN knowledge
//     requests (the ask half — ask-person plans the planner recorded,
//     policy-evaluated, still unanswered), the learning missions with
//     their confidence progress (management and employees see the same
//     legible state), the recent contributions with their acknowledgement
//     ladder, and the reward status/history rollup.
//   buildMissionLearningView — one mission's learning half: its open
//     knowledge requests, its contributions (acknowledgement + evidence),
//     and its rewards. Rendered as the W062 panels of the intelligence
//     mission detail page (W061 built the chain; this is the layer the
//     page's own comment reserves for W062).
//   buildRequestView        — one open knowledge request in full (the
//     answer flow's context: the question, the mission, the asked-of
//     person, the ask policy evaluation).
//
// Honesty rules (the answers.ts discipline of the intelligence surface):
//   * a FAILING read renders an empty section plus a `degraded` note —
//     never fake emptiness, never a crash;
//   * a MISSING record throws the owning contract's not-found error for
//     the page to render its honest not-found state;
//   * nothing here is persisted (lock 34) — views are derived, the
//     contracts own the truth;
//   * reward views carry ONLY the closed non-compensation vocabulary
//     (labels.ts; the compensation separation is tested).
//
// Tenancy (ADR-0001): every builder takes the EXPLICIT TenantContext;
// another tenant's records read as missing (the contracts' own
// `*_not_found` — no existence leak, no scope parameter in any URL).

import { now } from '@/infra/clock';
import type { TenantContext } from '@/infra/tenant';
import { getMission, listMissions } from '@/modules/missions/contract';
import type { Mission, MissionUrgency } from '@/modules/missions/contract';
import {
  listAcquisitionPlans,
  getAcquisitionPlan,
} from '@/modules/knowledge-acquisition/contract';
import type { AcquisitionPlan } from '@/modules/knowledge-acquisition/contract';
import {
  listContributions,
  summarizeContributions,
} from '@/modules/contributions/contract';
import type {
  Contribution,
  ContributionStatus,
  ContributionSummary,
  ContributionValidationOutcome,
  MissionImpactKind,
} from '@/modules/contributions/contract';
import { listRewards, summarizeRewards } from '@/modules/rewards/contract';
import type { Reward, RewardKind, RewardStatus, RewardSummary } from '@/modules/rewards/contract';
import { moneyLabel, percentLabel } from './labels';

// ---------------------------------------------------------------------------
// Row shapes (serialized server → page; labels resolved at render)
// ---------------------------------------------------------------------------

/** How many rows each hub list carries (the surface stays calm). */
export const HOME_ROW_LIMIT = 8;

/** One open knowledge request (the ask half). */
export interface KnowledgeRequestRow {
  planId: string;
  missionId: string;
  missionTitle: string | null;
  /** The composed, mission-derived question. */
  question: string;
  /** Who the question was asked of (the chosen person). */
  askedOf: string;
  /** The ask-policy evaluation that governed the question. */
  askPolicy: string | null;
  /** The planning rationale (why this source was chosen). */
  rationale: string | null;
  plannedAt: string;
}

/** One learning mission with its progress. */
export interface LearningMissionRow {
  id: string;
  title: string;
  knowledgeObjective: string;
  status: string;
  urgency: MissionUrgency;
  currentConfidence: number;
  targetConfidence: number;
  progressPercent: number;
  /** Confidence gained since the mission started, [0, 1]. */
  confidenceGain: number;
  investigationBudget: string;
  rewardBudget: string;
  rewardTerms: string | null;
  updatedAt: string;
}

/** One contribution with its acknowledgement. */
export interface ContributionRow {
  id: string;
  missionId: string;
  missionTitle: string | null;
  question: string;
  summary: string;
  contributorLabel: string | null;
  status: ContributionStatus;
  validation:
    | {
        outcome: ContributionValidationOutcome;
        quality: number;
        note: string | null;
        recordedAt: string;
        /** How many assessments the series holds (reassessment is kept). */
        seriesCount: number;
      }
    | null;
  impact:
    | {
        missionImpact: MissionImpactKind;
        knowledgeGain: number;
        confidenceBefore: number;
        confidenceAfter: number;
        avoidedCost: string | null;
        affectedGoalCount: number;
        recordedAt: string;
      }
    | null;
  /** The immutable observation carrying the answer (evidence capture). */
  evidenceObservationId: string;
  recordedAt: string;
}

/** One reward with its status/history. */
export interface RewardRow {
  id: string;
  missionId: string;
  missionTitle: string | null;
  contributorLabel: string | null;
  kind: RewardKind;
  tierName: string;
  amount: number;
  currency: string;
  status: RewardStatus;
  valueScore: number;
  /** The reward's authority gate decision link (the approval surface). */
  actionRequestId: string;
  settlement:
    | { decision: 'granted' | 'declined'; decidedAt: string | null; settledAt: string }
    | null;
  recordedAt: string;
}

/** The hub view (the /learning page's props). */
export interface LearningHomeView {
  generatedAt: string;
  /** Open ask-person knowledge requests, oldest first (fair queueing). */
  requests: KnowledgeRequestRow[];
  /** Active missions by urgency rank (listMissions' own ordering). */
  missions: LearningMissionRow[];
  /** Recently completed/abandoned missions (progress history). */
  settledMissions: LearningMissionRow[];
  /** Recent contributions, newest first. */
  contributions: ContributionRow[];
  /** The contribution-value rollup (management's coverage signal). */
  contributionSummary: ContributionSummary | null;
  /** Rewards, newest first. */
  rewards: RewardRow[];
  /** The reward rollup. */
  rewardSummary: RewardSummary | null;
  /** Which read families failed (honest degradation, never silence). */
  degraded: string[];
}

/** One planner decision on the mission's acquisition trail. */
export interface AcquisitionTrailRow {
  planId: string;
  decision: string;
  action: string | null;
  chosenLabel: string | null;
  question: string | null;
  outcome: string | null;
  evidenceObservationId: string | null;
  plannedAt: string;
}

/** One mission's learning half (the intelligence mission page's panels). */
export interface MissionLearningView {
  generatedAt: string;
  missionId: string;
  requests: KnowledgeRequestRow[];
  /** The planner's acquisition trail: every decision, any action. */
  trail: AcquisitionTrailRow[];
  contributions: ContributionRow[];
  rewards: RewardRow[];
  rewardSummary: RewardSummary | null;
  degraded: string[];
}

/** One knowledge request's full context (the answer flow). */
export interface RequestView {
  generatedAt: string;
  request: KnowledgeRequestRow;
  mission: LearningMissionRow;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** One bounded failed read → an empty section + a degraded note. */
async function safe<T>(
  family: string,
  degraded: string[],
  read: () => Promise<T>,
): Promise<T | null> {
  try {
    return await read();
  } catch {
    degraded.push(family);
    return null;
  }
}

function clip(text: string, bound: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= bound ? flat : `${flat.slice(0, bound - 1)}…`;
}

function toRequestRow(
  plan: AcquisitionPlan,
  missionTitle: string | null,
): KnowledgeRequestRow {
  return {
    planId: plan.id,
    missionId: plan.missionId,
    missionTitle,
    question: clip(plan.question ?? '(the planner recorded no question)', 400),
    askedOf: plan.chosen?.label ?? plan.chosen?.id ?? 'the selected source',
    askPolicy: plan.askPolicy === null ? null : plan.askPolicy.outcome,
    rationale: plan.rationale === null ? null : clip(plan.rationale, 240),
    plannedAt: plan.recordedAt,
  };
}

function toMissionRow(mission: Mission): LearningMissionRow {
  const content = mission.content;
  const current = content.currentConfidence;
  const target = content.targetConfidence;
  const safeTarget = Math.max(target, 0.01);
  return {
    id: mission.id,
    title: clip(content.title, 160),
    knowledgeObjective: clip(content.knowledgeObjective, 400),
    status: content.status,
    urgency: content.urgency,
    currentConfidence: current,
    targetConfidence: target,
    progressPercent: Math.min(100, Math.round((current / safeTarget) * 100)),
    confidenceGain: Math.max(0, current),
    investigationBudget: moneyLabel(
      content.investigationBudget.amount,
      content.investigationBudget.currency,
    ),
    rewardBudget: moneyLabel(content.rewardBudget.amount, content.rewardBudget.currency),
    rewardTerms: content.rewardTerms === null ? null : clip(content.rewardTerms, 240),
    updatedAt: mission.updatedAt,
  };
}

function toContributionRow(
  contribution: Contribution,
  missionTitle: string | null,
): ContributionRow {
  const validation = contribution.validation;
  const impact = contribution.impact;
  return {
    id: contribution.id,
    missionId: contribution.missionId,
    missionTitle,
    question: clip(contribution.question, 300),
    summary: clip(contribution.summary, 400),
    contributorLabel: contribution.contributor.label,
    status: contribution.status,
    validation:
      validation === null
        ? null
        : {
            outcome: validation.outcome,
            quality: validation.quality,
            note: validation.note === null ? null : clip(validation.note, 200),
            recordedAt: validation.recordedAt,
            seriesCount: contribution.validationCount,
          },
    impact:
      impact === null
        ? null
        : {
            missionImpact: impact.missionImpact,
            knowledgeGain: impact.knowledgeGain,
            confidenceBefore: impact.confidenceBefore,
            confidenceAfter: impact.confidenceAfter,
            avoidedCost: moneyLabel(impact.avoidedCost, contribution.budgetCurrency),
            affectedGoalCount: impact.affectedGoals.length,
            recordedAt: impact.recordedAt,
          },
    evidenceObservationId: contribution.evidenceObservationId,
    recordedAt: contribution.recordedAt,
  };
}

function toRewardRow(reward: Reward, missionTitle: string | null): RewardRow {
  return {
    id: reward.id,
    missionId: reward.missionId,
    missionTitle,
    contributorLabel: reward.contributor.label ?? null,
    kind: reward.tier.kind,
    tierName: reward.tier.name,
    amount: reward.tier.amount,
    currency: reward.tier.currency,
    status: reward.status,
    valueScore: reward.valueScore,
    actionRequestId: reward.actionRequestId,
    settlement:
      reward.settlement === null
        ? null
        : {
            decision: reward.settlement.decision,
            decidedAt: reward.settlement.decidedAt,
            settledAt: reward.settlement.settledAt,
          },
    recordedAt: reward.recordedAt,
  };
}

/**
 * The mission titles the row builders resolve. The missions contract
 * offers no by-ids batch read, so titles resolve one bounded getMission
 * read per distinct mission id (≤ 24). A not-found mission id (missing
 * or foreign-tenant — indistinguishable by design) simply carries no
 * title; any other failure degrades the titles pass once (honest, never
 * silent, never a crash over optional metadata).
 */
async function missionTitleMap(
  ctx: TenantContext,
  degraded: string[],
  ids: readonly string[],
): Promise<Map<string, string>> {
  const titles = new Map<string, string>();
  let hardFailure = false;
  for (const id of [...new Set(ids)].slice(0, 24)) {
    try {
      const mission = await getMission(ctx, id);
      titles.set(id, clip(mission.content.title, 160));
    } catch (error) {
      const code =
        typeof error === 'object' && error !== null && 'code' in error
          ? String((error as { code: unknown }).code)
          : null;
      if (code !== null && code.endsWith('_not_found')) continue;
      hardFailure = true;
    }
  }
  if (hardFailure) degraded.push('missions');
  return titles;
}

// ---------------------------------------------------------------------------
// buildLearningHomeView
// ---------------------------------------------------------------------------

/** The open-knowledge-request feed: ask-person plans without outcomes. */
async function openRequests(
  ctx: TenantContext,
  degraded: string[],
): Promise<KnowledgeRequestRow[]> {
  const plans = await safe('knowledge-acquisition', degraded, () =>
    listAcquisitionPlans(ctx, { action: 'ask-person', limit: 100 }),
  );
  if (plans === null) return [];
  const open = plans.filter(
    (plan) => plan.decision === 'selected' && plan.outcome === null && plan.question !== null,
  );
  const titles = await missionTitleMap(
    ctx,
    degraded,
    open.map((plan) => plan.missionId),
  );
  const rows = open.map((plan) => toRequestRow(plan, titles.get(plan.missionId) ?? null));
  // Oldest first: the request that waited longest is answered first.
  rows.sort((left, right) => left.plannedAt.localeCompare(right.plannedAt));
  return rows.slice(0, HOME_ROW_LIMIT);
}

/** Build the Learning hub view. */
export async function buildLearningHomeView(ctx: TenantContext): Promise<LearningHomeView> {
  const degraded: string[] = [];

  const [requests, missionsRead, contributionsRead, rewardsRead, contributionSummary, rewardSummary] =
    await Promise.all([
      openRequests(ctx, degraded),
      safe('missions', degraded, () => listMissions(ctx, { limit: 24 })),
      safe('contributions', degraded, () => listContributions(ctx, { limit: 12 })),
      safe('rewards', degraded, () => listRewards(ctx, { limit: 12 })),
      safe('contributions', degraded, () => summarizeContributions(ctx, {})),
      safe('rewards', degraded, () => summarizeRewards(ctx, {})),
    ]);

  const missions = (missionsRead ?? []).map(toMissionRow);
  const active = missions.filter((mission) => mission.status === 'active');
  const settled = missions.filter((mission) => mission.status !== 'active');

  const titles = await missionTitleMap(
    ctx,
    degraded,
    (contributionsRead ?? []).map((contribution) => contribution.missionId),
  );
  const contributions = (contributionsRead ?? []).map((contribution) =>
    toContributionRow(contribution, titles.get(contribution.missionId) ?? null),
  );

  const rewardTitles = await missionTitleMap(
    ctx,
    degraded,
    (rewardsRead ?? []).map((reward) => reward.missionId),
  );
  const rewards = (rewardsRead ?? []).map((reward) =>
    toRewardRow(reward, rewardTitles.get(reward.missionId) ?? null),
  );

  return {
    generatedAt: now().toISOString(),
    requests,
    missions: active.slice(0, HOME_ROW_LIMIT),
    settledMissions: settled.slice(0, 4),
    contributions: contributions.slice(0, HOME_ROW_LIMIT),
    contributionSummary,
    rewards: rewards.slice(0, HOME_ROW_LIMIT),
    rewardSummary,
    degraded: [...new Set(degraded)],
  };
}

// ---------------------------------------------------------------------------
// buildMissionLearningView
// ---------------------------------------------------------------------------

/** Build one mission's learning half (the mission page's W062 panels). */
export async function buildMissionLearningView(
  ctx: TenantContext,
  missionId: string,
): Promise<MissionLearningView> {
  const degraded: string[] = [];

  // The owning read: a missing/foreign mission throws mission_not_found.
  const mission = await getMission(ctx, missionId);
  const missionTitle = clip(mission.content.title, 160);

  const [personPlans, allPlans, contributions, rewards, rewardSummary] = await Promise.all([
    safe('knowledge-acquisition', degraded, () =>
      listAcquisitionPlans(ctx, { missionId, action: 'ask-person', limit: 50 }),
    ),
    safe('knowledge-acquisition', degraded, () =>
      listAcquisitionPlans(ctx, { missionId, limit: 24 }),
    ),
    safe('contributions', degraded, () => listContributions(ctx, { missionId, limit: 24 })),
    safe('rewards', degraded, () => listRewards(ctx, { missionId, limit: 24 })),
    safe('rewards', degraded, () => summarizeRewards(ctx, { missionId })),
  ]);

  const open = (personPlans ?? []).filter(
    (plan) => plan.decision === 'selected' && plan.outcome === null && plan.question !== null,
  );
  const requests = open.map((plan) => toRequestRow(plan, missionTitle));
  requests.sort((left, right) => left.plannedAt.localeCompare(right.plannedAt));

  // The acquisition trail: every planner decision for this mission, any
  // action, newest first — the surface-triggered asks and the loop's
  // planner passes land on the SAME append-only audit trail.
  const trail: AcquisitionTrailRow[] = (allPlans ?? []).map((plan) => ({
    planId: plan.id,
    decision: plan.decision,
    action: plan.action,
    chosenLabel: plan.chosen === null ? null : plan.chosen.label ?? plan.chosen.id,
    question: plan.question === null ? null : clip(plan.question, 240),
    outcome: plan.outcome === null ? null : plan.outcome.outcome,
    evidenceObservationId: plan.outcome === null ? null : plan.outcome.evidenceObservationId,
    plannedAt: plan.recordedAt,
  }));
  trail.sort((left, right) => right.plannedAt.localeCompare(left.plannedAt));

  return {
    generatedAt: now().toISOString(),
    missionId,
    requests,
    trail,
    contributions: (contributions ?? []).map((contribution) =>
      toContributionRow(contribution, missionTitle),
    ),
    rewards: (rewards ?? []).map((reward) => toRewardRow(reward, missionTitle)),
    rewardSummary,
    degraded: [...new Set(degraded)],
  };
}

// ---------------------------------------------------------------------------
// buildRequestView
// ---------------------------------------------------------------------------

/** Build one open knowledge request's full answer context. */
export async function buildRequestView(
  ctx: TenantContext,
  planId: string,
): Promise<RequestView> {
  const plan = await getAcquisitionPlan(ctx, planId);
  const mission = await getMission(ctx, plan.missionId);
  return {
    generatedAt: now().toISOString(),
    request: toRequestRow(plan, clip(mission.content.title, 160)),
    mission: toMissionRow(mission),
  };
}

/** Progress copy shared by the mission rows (used by the page). */
export function progressLine(mission: LearningMissionRow): string {
  return `Confidence ${percentLabel(mission.currentConfidence)} of ${percentLabel(
    mission.targetConfidence,
  )} — ${mission.progressPercent}% toward target`;
}
