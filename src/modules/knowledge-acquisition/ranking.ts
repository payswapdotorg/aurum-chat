// Pure ranking and questioning logic of the knowledge-acquisition module
// (W012 — Knowledge Acquisition Planner). No database, no context, no
// time — everything here is a total, deterministic function of its
// arguments, which is exactly what ADR-0018 demands: "Ranking is
// deterministic at the policy/workflow level: the same inputs and the
// same learned state produce the same ordering."
//
// The composite score weighs the six positive ADR-0018 signals with FIXED
// code-level weights (the policy/workflow level) and subtracts a cost
// penalty proportional to the candidate's share of the mission's
// investigation budget:
//
//   score = 0.30·relevance + 0.20·reliability + 0.15·authority
//         + 0.15·expectedQuality + 0.10·freshness + 0.05·priorContributionValue
//         − 0.15·costShare
//
// Positive weights sum to 0.95 and the penalty is at most 0.15, so the
// score's range is [−0.15, 0.95] by construction. Every candidate is
// scored (excluded candidates too — the score is part of the persisted
// rationale); eligibility is decided by the deterministic gate chain in
// the service, never by the arithmetic. Employees and systems therefore
// compete on the same measurable dimensions (ADR-0018 consequence), and a
// signal change that flips the ordering is always reconstructable from
// the persisted signal vector.
//
// The candidate ORDER is total and deterministic: score (rounded to 6
// decimals) descending, then the §7 menu order of kinds (person, system,
// document, external, agent, analysis), then the candidate key ascending.
// Selection is "the first eligible candidate in that order" — one next
// best action per planning pass, never "query everyone" (lock 17).

import type { MissionCandidateKind } from '@/modules/missions/contract';
import type { AcquisitionActionKind, RankedCandidate, SignalName } from './types';

// ---------------------------------------------------------------------------
// Vocabularies
// ---------------------------------------------------------------------------

/**
 * The acquisition action each candidate kind maps onto (§7's selection
 * menu → the action to perform). `person` covers employees and managers.
 */
export const ACQUISITION_ACTIONS: Record<MissionCandidateKind, AcquisitionActionKind> = {
  person: 'ask-person',
  system: 'query-system',
  document: 'retrieve-document',
  external: 'fetch-external',
  agent: 'commission-agent',
  analysis: 'run-analysis',
};

/** The acquisition action vocabulary (mirrored by the migration CHECK). */
export const ACQUISITION_ACTION_KINDS = [
  'ask-person',
  'query-system',
  'retrieve-document',
  'fetch-external',
  'commission-agent',
  'run-analysis',
] as const;

/** The §7 menu order of candidate kinds — the deterministic tie-break. */
export const CANDIDATE_KIND_ORDER: readonly MissionCandidateKind[] = [
  'person',
  'system',
  'document',
  'external',
  'agent',
  'analysis',
];

export function isAcquisitionActionKind(value: unknown): value is AcquisitionActionKind {
  return (
    typeof value === 'string' &&
    (ACQUISITION_ACTION_KINDS as readonly string[]).includes(value)
  );
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/**
 * The fixed policy/workflow-level weights of the ranking (ADR-0018):
 * six positive signals plus the cost penalty. Changing these changes the
 * ranking policy — they are deliberately constants, not tenant state, so
 * "learning" can only modulate ranking through the signal VALUES, never
 * through the arithmetic (lock 14's spirit).
 */
export const SIGNAL_WEIGHTS = {
  relevance: 0.3,
  reliability: 0.2,
  authority: 0.15,
  expectedQuality: 0.15,
  freshness: 0.1,
  priorContributionValue: 0.05,
  costPenalty: 0.15,
} as const;

/** Rounds to 6 decimals — the persisted/compared score granularity. */
function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/**
 * The stable identity of one candidate: `(kind, id)` when the candidate
 * carries an id (the missions module's uuid rule), `(kind, label)`
 * otherwise. Prior plans' chosen candidates are matched back onto the
 * mission menu with exactly this key, which is what makes "already
 * attempted" detection reliable across mission revisions.
 */
export function candidateKey(candidate: {
  kind: MissionCandidateKind;
  id?: string | null;
  label?: string | null;
}): string {
  const identity =
    candidate.id !== undefined && candidate.id !== null
      ? `id:${candidate.id}`
      : `label:${candidate.label ?? ''}`;
  return `${candidate.kind}:${identity}`;
}

/**
 * A candidate's cost as a share of the mission's investigation budget,
 * capped at 1 (a cost above budget is a full share). A zero budget makes
 * any positive cost a full share and a zero cost free.
 */
export function computeCostShare(cost: number, budgetAmount: number): number {
  if (cost <= 0) return 0;
  if (budgetAmount <= 0) return 1;
  return round6(Math.min(1, cost / budgetAmount));
}

/** The deterministic composite evaluation of one candidate's signals. */
export interface CandidateScore {
  score: number;
  costShare: number;
  /** The highest-weighted positive signal contribution. */
  dominantSignal: SignalName;
}

/**
 * Scores one candidate: the weighted signal sum minus the cost penalty
 * (see the header formula). Pure and total — the same signals and the
 * same budget always produce the same score, cost share and dominant
 * signal.
 */
export function scoreCandidateSignals(
  signals: {
    relevance: number;
    reliability: number;
    freshness: number;
    authority: number;
    expectedQuality: number;
    priorContributionValue: number;
  },
  cost: number,
  budgetAmount: number,
): CandidateScore {
  const weighted: ReadonlyArray<[SignalName, number]> = [
    ['relevance', SIGNAL_WEIGHTS.relevance * signals.relevance],
    ['reliability', SIGNAL_WEIGHTS.reliability * signals.reliability],
    ['authority', SIGNAL_WEIGHTS.authority * signals.authority],
    ['expectedQuality', SIGNAL_WEIGHTS.expectedQuality * signals.expectedQuality],
    ['freshness', SIGNAL_WEIGHTS.freshness * signals.freshness],
    ['priorContributionValue', SIGNAL_WEIGHTS.priorContributionValue * signals.priorContributionValue],
  ];
  let dominantSignal: SignalName = weighted[0]![0];
  let dominantValue = Number.NEGATIVE_INFINITY;
  for (const [name, value] of weighted) {
    if (value > dominantValue) {
      dominantSignal = name;
      dominantValue = value;
    }
  }
  const costShare = computeCostShare(cost, budgetAmount);
  const score = round6(
    weighted.reduce((sum, [, value]) => sum + value, 0) -
      SIGNAL_WEIGHTS.costPenalty * costShare,
  );
  return { score, costShare, dominantSignal };
}

/**
 * The total deterministic candidate order: score descending, then the §7
 * menu order of kinds, then the candidate key ascending. Returns a new
 * array; the input is not mutated. Selection is "first eligible in this
 * order" — the service decides eligibility.
 */
export function orderRankedCandidates(candidates: RankedCandidate[]): RankedCandidate[] {
  const kindRank = new Map(CANDIDATE_KIND_ORDER.map((kind, index) => [kind, index]));
  return [...candidates].sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    const rankA = kindRank.get(a.candidate.kind) ?? CANDIDATE_KIND_ORDER.length;
    const rankB = kindRank.get(b.candidate.kind) ?? CANDIDATE_KIND_ORDER.length;
    if (rankA !== rankB) return rankA - rankB;
    return candidateKey(a.candidate) < candidateKey(b.candidate) ? -1 : 1;
  });
}

// ---------------------------------------------------------------------------
// Targeted questioning
// ---------------------------------------------------------------------------

/**
 * Display-name bound for question composition: the missions module caps
 * labels at 200 characters and the composed question must stay within its
 * storage CHECK (4000) for ANY mission content — the people module does
 * not bound `fullName`, so the composer bounds it here, deterministically.
 */
export const MAX_PERSON_NAME_LENGTH = 200;

/**
 * Composes the targeted question for one employee, deterministically from
 * the mission (§7 "mission-driven targeted employee questioning"): the
 * mission's knowledge objective IS the question, addressed to the
 * resolved employee by name. No LLM participates — the question is pure
 * code over mission content, so it is reproducible and auditable, and a
 * later, LLM-phrased delivery layer (W013+/W030) can never change WHAT
 * was asked, only how it is worded for the channel.
 */
export function composeTargetedQuestion(input: {
  missionTitle: string;
  knowledgeObjective: string;
  personName: string;
}): string {
  const personName = input.personName.slice(0, MAX_PERSON_NAME_LENGTH);
  return (
    `Hello ${personName} — Aurum is working on the mission ` +
    `"${input.missionTitle}" and needs your knowledge to answer: ` +
    `${input.knowledgeObjective} What can you tell us about this?`
  );
}
