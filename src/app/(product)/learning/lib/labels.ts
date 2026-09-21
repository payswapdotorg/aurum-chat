// Learning missions, contributions & rewards (W062) — the pure copy,
// tone and formatting vocabulary of the learning surface.
//
// THE LAST ACCEPTANCE CLAUSE IS STRUCTURAL HERE: "no compensation or
// performance semantics leakage". The domain already enforces it
// (rewards/validation.ts closes the reward-kind vocabulary to
// non-compensation shapes and the storage CHECK rejects compensation
// kinds); this module is the UX half of the same discipline:
//   * every label the surface renders for rewards comes from THIS file,
//     and the unit tests pin that the vocabulary and copy contain no
//     compensation/performance term;
//   * the one place the separation is stated in product copy
//     (REWARD_SEPARATION_NOTE) says exactly what the frozen architecture
//     says: a reward RECOGNIZES a knowledge contribution — it is never a
//     compensation decision and never a performance rating (lock 9,
//     ARCHITECTURE.md §8).
//
// Color never carries meaning alone (the shell's pill discipline): every
// mapping here pairs a tone with a human label, and the caller renders
// both.

import type { PillTone } from '../../lib/states';
import type {
  ContributionStatus,
  ContributionValidationOutcome,
  MissionImpactKind,
} from '@/modules/contributions/contract';
import type { RewardKind, RewardStatus, SettlementDecision } from '@/modules/rewards/contract';
import type { MissionUrgency } from '@/modules/missions/contract';
import { REWARD_KINDS } from '@/modules/rewards/contract';

// ---------------------------------------------------------------------------
// The compensation/performance separation (the acceptance's final clause)
// ---------------------------------------------------------------------------

/**
 * The terms this surface's reward copy must NEVER use. The unit tests
 * sweep every exported label/copy constant of this module against this
 * list — the UX can never drift into compensation/performance semantics
 * without a failing test.
 */
export const COMPENSATION_FORBIDDEN_TERMS: readonly string[] = [
  'compensation',
  'compensate',
  'salary',
  'salaries',
  'payroll',
  'wage',
  'bonus',
  'merit',
  'performance',
  'appraisal',
  'rating',
  'kpi',
  'promotion',
  'termination',
  'severance',
];

/**
 * The one honest sentence that states the separation in product copy —
 * deliberately phrased as the reward's RECOGNITION shape, never as pay.
 */
export const REWARD_SEPARATION_NOTE =
  'A reward recognizes a knowledge contribution under the company\u2019s explicit reward policy. It is separate from the company\u2019s own people decisions — it is not pay, and it is not an assessment of anyone\u2019s work quality.';

/** The offending forbidden term a text contains, or null when clean. */
export function usesForbiddenTerm(text: string): string | null {
  const lower = text.toLowerCase();
  for (const term of COMPENSATION_FORBIDDEN_TERMS) {
    if (lower.includes(term)) return term;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Contribution acknowledgement (the W042 status ladder, legible)
// ---------------------------------------------------------------------------

/** The tone of a contribution status (color never carries it alone). */
export function contributionStatusTone(status: ContributionStatus): PillTone {
  switch (status) {
    case 'pending':
      return 'neutral';
    case 'validated':
      return 'positive';
    case 'contradicted':
      return 'warning';
    case 'rejected':
      return 'error';
    case 'measured':
      return 'info';
  }
}

/** Human copy for a contribution status (the acknowledgement ladder). */
export function contributionStatusLabel(status: ContributionStatus): string {
  switch (status) {
    case 'pending':
      return 'Recorded — awaiting assessment';
    case 'validated':
      return 'Validated';
    case 'contradicted':
      return 'Contradicted — evidence conflict retained';
    case 'rejected':
      return 'Rejected';
    case 'measured':
      return 'Measured — impact recorded';
  }
}

/** What the ladder step means for the contributor (the acknowledgement). */
export function contributionStatusExplanation(status: ContributionStatus): string {
  switch (status) {
    case 'pending':
      return 'Aurum recorded the answer as evidence; its quality is being assessed against the mission\u2019s other sources.';
    case 'validated':
      return 'The answer\u2019s evidence quality was assessed and accepted.';
    case 'contradicted':
      return 'The answer conflicts with other retained evidence — the conflict is kept, not deleted.';
    case 'rejected':
      return 'The answer\u2019s evidence was assessed and not accepted.';
    case 'measured':
      return 'The answer\u2019s effect on the mission\u2019s confidence was measured and frozen.';
  }
}

/** Tone for one evidence-quality validation outcome. */
export function validationOutcomeTone(outcome: ContributionValidationOutcome): PillTone {
  switch (outcome) {
    case 'validated':
      return 'positive';
    case 'contradicted':
      return 'warning';
    case 'rejected':
      return 'error';
  }
}

export function validationOutcomeLabel(outcome: ContributionValidationOutcome): string {
  switch (outcome) {
    case 'validated':
      return 'Assessed — validated';
    case 'contradicted':
      return 'Assessed — contradicted';
    case 'rejected':
      return 'Assessed — rejected';
  }
}

/** What a contribution did to its mission (the frozen impact kind). */
export function missionImpactLabel(kind: MissionImpactKind): string {
  switch (kind) {
    case 'advanced':
      return 'advanced the mission\u2019s confidence';
    case 'resolved':
      return 'resolved the mission';
    case 'no_effect':
      return 'no measurable effect on confidence';
  }
}

// ---------------------------------------------------------------------------
// Reward status/history (the W043 vocabulary, non-compensation only)
// ---------------------------------------------------------------------------

/** The tone of a reward status. */
export function rewardStatusTone(status: RewardStatus): PillTone {
  switch (status) {
    case 'proposed':
      return 'warning';
    case 'granted':
      return 'positive';
    case 'declined':
      return 'neutral';
    case 'refused':
      return 'error';
  }
}

/** Human copy for a reward status. */
export function rewardStatusLabel(status: RewardStatus): string {
  switch (status) {
    case 'proposed':
      return 'Proposed — awaiting the approval decision';
    case 'granted':
      return 'Granted';
    case 'declined':
      return 'Declined';
    case 'refused':
      return 'Refused — outside policy';
  }
}

/** What a reward status means for the contributor (honest history copy). */
export function rewardStatusExplanation(status: RewardStatus): string {
  switch (status) {
    case 'proposed':
      return 'The reward policy converted the contribution into a configured reward; the human approval gate now holds it until a decision is made.';
    case 'granted':
      return 'The approval gate decided to grant this reward.';
    case 'declined':
      return 'The approval gate decided not to grant this reward.';
    case 'refused':
      return 'The authority policy refused the reward at the gate — nothing was granted.';
  }
}

/** The settlement decision that terminated a gated reward. */
export function settlementDecisionLabel(decision: SettlementDecision): string {
  switch (decision) {
    case 'granted':
      return 'decided to grant';
    case 'declined':
      return 'decided to decline';
  }
}

/** Human copy for a configured reward kind — the closed W043 vocabulary. */
export function rewardKindLabel(kind: RewardKind): string {
  switch (kind) {
    case 'recognition':
      return 'Recognition';
    case 'gift':
      return 'Gift';
    case 'voucher':
      return 'Voucher';
    case 'experience':
      return 'Experience';
    case 'donation':
      return 'Donation';
  }
}

/**
 * The full reward-kind label set, keyed by the closed vocabulary. The
 * unit tests pin that every REWARD_KINDS member has a label and that no
 * label carries a compensation/performance term.
 */
export const REWARD_KIND_LABELS: Readonly<Record<RewardKind, string>> = Object.fromEntries(
  REWARD_KINDS.map((kind) => [kind, rewardKindLabel(kind)]),
) as Readonly<Record<RewardKind, string>>;

// ---------------------------------------------------------------------------
// Knowledge requests (the ask/answer legibility)
// ---------------------------------------------------------------------------

/** Tone for a mission urgency band (the intelligence precedent). */
export function missionUrgencyTone(urgency: MissionUrgency): PillTone {
  switch (urgency) {
    case 'critical':
      return 'error';
    case 'high':
      return 'warning';
    case 'medium':
      return 'info';
    case 'low':
      return 'neutral';
  }
}

/** Copy for the ask-policy evaluation that governed a person question. */
export function askPolicyNote(outcome: string): string {
  switch (outcome) {
    case 'allowed':
      return 'Policy permits asking this question.';
    case 'approval_required':
      return 'Policy requires an approval before this question may be asked.';
    default:
      return 'Policy did not permit asking this question.';
  }
}

// ---------------------------------------------------------------------------
// Formatting (money stays integer minor units + ISO currency)
// ---------------------------------------------------------------------------

/** Minor units + ISO currency → human text, e.g. `12.50 USD`. */
export function moneyLabel(amount: number, currency: string): string {
  return `${(amount / 100).toFixed(2)} ${currency}`;
}

/** A [0, 1] score as a compact percent, e.g. `62%`. */
export function percentLabel(value: number): string {
  return `${Math.round(value * 100).toFixed(0)}%`;
}

/** Mission confidence progress: current against target, never above 100%. */
export function missionProgressPercent(current: number, target: number): number {
  const safeTarget = Math.max(target, 0.01);
  return Math.min(100, Math.round((current / safeTarget) * 100));
}

/** Compact date copy (invalid dates pass through untouched — no lies). */
export function dateLabel(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString('en', { year: 'numeric', month: 'short', day: 'numeric' });
}
