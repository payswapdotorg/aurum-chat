// Pure source-evidence → ranking-signal derivation of the
// knowledge-acquisition module (W052 — Knowledge Source Ranking, ADR-0018).
//
// W012's ranking.ts owns the deterministic EVALUATION of caller-supplied
// signal values (fixed weights, total order, eligibility gates). W052 owns
// the layer beneath it: WHERE the signal values come from. ADR-0018:
// "Aurum ranks possible knowledge sources using provider-independent
// signals … Ranking is deterministic at the policy/workflow level: the same
// inputs and the same learned state produce the same ordering" and "Learned
// source reliability (CompanyModel) modulates ranking without overriding
// explicit access policy." The W012 planner deliberately left the signal
// VALUES to its caller (its types.ts: "W013 cognition and W052 knowledge
// source ranking compute them from memory, the world model and the
// CompanyModel"); this file is that computation for the evidence this
// repository already persists:
//
//   reliability, expectedQuality, priorContributionValue, freshness
//     ← the source's terminal acquisition-outcome history (the planner's
//       own append-only records, tenant-wide — the learned CompanyModel
//       track record of the source) and, through the observations
//       contract, the confidence and observation clock of the evidence
//       each answered acquisition produced;
//   relevance, authority
//     ← transactive memory (the memory module's W010 contract — §7
//       "who knows, owns, decides, has experience with, influences, or can
//       perform a capability") matched against the mission's subject
//       topics, which are derived deterministically from the mission's
//       title + knowledge objective by pure tokenization;
//   cost, access
//     ← NEVER learned: explicit caller policy on every ranking call
//       (ADR-0018: learned state never overrides explicit access policy).
//
// Everything here is a total, deterministic function of its arguments
// (plus, for freshness, the explicit evaluation instant the caller passes
// in — the same instant the service stamps on the ranking record). No
// database, no context, no hidden time: the service assembles the evidence
// snapshots (source-ranking evidence loaders in service.ts), these
// functions turn them into the separately represented ADR-0018 signals
// plus the basis that explains each value, and the planner's own
// scoreCandidateSignals then evaluates them. The same evidence and the
// same instant therefore always produce the same signal vector, the same
// basis and the same ordering — the synthetic ADR-0018 verification
// (routing changes when source evidence changes, with the persisted
// rationale identifying which signal moved) diffs two of these snapshots.

import type { TransactiveRelation } from '@/modules/memory/contract';
import { CANDIDATE_KIND_ORDER, candidateKey } from './ranking';
import type {
  RankedSource,
  SourceEvidenceBasis,
  SourceEvidenceSnapshot,
  SourceOutcomeCounts,
  SourceTransactiveEntrySnapshot,
} from './types';

// ---------------------------------------------------------------------------
// Fixed derivation constants (the policy/workflow level of the DERIVATION)
// ---------------------------------------------------------------------------

/**
 * The neutral signal value: what a signal takes when the evidence gives no
 * reason either way (no outcome history, no transactive record, no
 * mission topics to match against). Learning can only move a signal away
 * from neutral with actual evidence — never with assumption.
 */
export const NEUTRAL_SIGNAL = 0.5;

/**
 * Laplace prior of the reliability estimate: one pseudo-outcome on each
 * side, so `answered/total` becomes `(answered + 1)/(total + 2)` and a
 * source with no history sits exactly at NEUTRAL_SIGNAL (0.5) rather than
 * at an unjustified 0 or 1.
 */
export const RELIABILITY_PRIOR = 1;

/**
 * Half-life of the freshness signal, in days: a source whose latest
 * answered evidence was observed `n × 30` days ago scores `0.5^n`.
 * Thirty days is the tenants' typical monthly operating cadence; the
 * exact constant is policy, not physics — it is fixed here so the decay
 * is deterministic and auditable.
 */
export const FRESHNESS_HALF_LIFE_DAYS = 30;

/**
 * Saturation constant of the prior-contribution-value signal: a source's
 * answered count maps to `answered/(answered + 4)`, so four useful
 * contributions are half the achievable value and the signal approaches 1
 * without ever granting certainty. A source that never contributed scores
 * exactly 0 — the value of nothing is nothing (unreached evidence is not
 * evidence of value).
 */
export const CONTRIBUTION_SATURATION = 4;

/**
 * Saturation constant of the relevance signal: the number of mission
 * subject topics a source is on record as knowing maps to
 * `matched/(matched + 1)`, so a single shared topic lands exactly on the
 * neutral prior (one word of overlap is not yet relevance), and each
 * additional matched topic adds less than the last.
 */
export const RELEVANCE_SATURATION = 1;

/**
 * How many of a source's most recent terminal acquisition outcomes the
 * derivation considers (the learning window). Bounded so a ranking pass
 * does a bounded amount of work per candidate; recent behavior is what
 * the CompanyModel should learn from anyway. Older outcomes exist
 * unchanged in the append-only history — they are simply outside the
 * window, deterministically.
 */
export const LEARNING_WINDOW = 25;

/**
 * How many of an actor's most recent transactive-memory entries the
 * derivation consults (same bounding rationale as LEARNING_WINDOW).
 */
export const TRANSACTIVE_WINDOW = 100;

/** How many mission subject topics the derivation keeps (title first). */
export const MISSION_TOPIC_CAP = 16;

/** Shortest token that can be a subject topic (single letters are noise). */
export const MIN_TOPIC_LENGTH = 2;

/**
 * The authority strength of each §7 transactive relation, fixed: the
 * decision-maker on a subject outranks its owner, who outranks the one
 * who can perform it, who outranks the one who merely knows it, and so
 * on down to influence without ownership. This order is policy, not
 * measurement — it is what "authority" MEANS here, and it is constant so
 * the derivation stays deterministic and explainable.
 */
export const RELATION_AUTHORITY: Record<TransactiveRelation, number> = {
  decides: 1.0,
  owns: 0.9,
  can_perform: 0.8,
  knows: 0.7,
  has_experience_with: 0.6,
  influences: 0.5,
};

/**
 * English function words that carry no subject matter. The tokenizer
 * drops them so mission subject topics are the mission's CONTENT words
 * (what the knowledge objective is about), not its grammar.
 */
export const TOPIC_STOPWORDS: ReadonlySet<string> = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'then', 'else', 'when',
  'at', 'by', 'for', 'with', 'about', 'against', 'between', 'into',
  'through', 'during', 'before', 'after', 'above', 'below', 'to', 'from',
  'up', 'down', 'in', 'out', 'on', 'off', 'over', 'under', 'again',
  'further', 'once', 'here', 'there', 'all', 'any', 'both', 'each',
  'few', 'more', 'most', 'other', 'some', 'such', 'no', 'nor', 'not',
  'only', 'own', 'same', 'so', 'than', 'too', 'very', 'can', 'will',
  'just', 'should', 'now', 'is', 'are', 'was', 'were', 'be', 'been',
  'being', 'have', 'has', 'had', 'having', 'do', 'does', 'did', 'doing',
  'would', 'could', 'ought', 'must', 'shall', 'may', 'might', 'i', 'you',
  'he', 'she', 'it', 'we', 'they', 'them', 'his', 'her', 'its', 'our',
  'their', 'what', 'which', 'who', 'whom', 'this', 'that', 'these',
  'those', 'am', 'of', 'as', 'until', 'while', 'how', 'why', 'where',
]);

/** Rounds to 6 decimals — the persisted/compared signal granularity. */
function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

// ---------------------------------------------------------------------------
// Mission subject topics
// ---------------------------------------------------------------------------

/**
 * The mission's subject topics: the distinctive content words of its title
 * and knowledge objective, lowercased, deduplicated in first-occurrence
 * order (the title is the headline subject, so it is processed first) and
 * capped at MISSION_TOPIC_CAP. Pure and total — the same mission text
 * always yields the same topics, so relevance and authority match against
 * a stable subject. Grammar words and one-letter tokens are dropped; a
 * mission whose entire text is grammar words yields no topics, and the
 * relevance/authority derivations fall back to NEUTRAL_SIGNAL for every
 * candidate (no subject to match against — no relevance judgement).
 */
export function missionSubjectTopics(
  title: string,
  knowledgeObjective: string,
): string[] {
  const topics: string[] = [];
  const seen = new Set<string>();
  for (const word of `${title} ${knowledgeObjective}`
    .toLowerCase()
    .split(/[^a-z0-9]+/)) {
    if (word.length < MIN_TOPIC_LENGTH || TOPIC_STOPWORDS.has(word)) continue;
    if (seen.has(word)) continue;
    if (topics.length >= MISSION_TOPIC_CAP) break;
    seen.add(word);
    topics.push(word);
  }
  return topics;
}

// ---------------------------------------------------------------------------
// Outcome-history signals (the learned CompanyModel track record)
// ---------------------------------------------------------------------------

/**
 * Historical reliability: the Laplace-smoothed answered share of the
 * source's terminal outcomes (SourceOutcomeCounts, types.ts). A source
 * with no history sits at the neutral prior (an unreached source is
 * neither trusted nor distrusted); every terminal outcome moves the
 * estimate toward (answered) or away from (unavailable, failed) the
 * source.
 */
export function reliabilityFromOutcomes(counts: SourceOutcomeCounts): number {
  const total = counts.answered + counts.unavailable + counts.failed;
  if (total === 0) return NEUTRAL_SIGNAL;
  return round6(
    (counts.answered + RELIABILITY_PRIOR) / (total + 2 * RELIABILITY_PRIOR),
  );
}

/**
 * Expected answer/evidence quality: the mean confidence of the source's
 * answered evidence (what the observations recorded with each answer).
 * No readable answered evidence → the neutral prior (quality unknown, not
 * presumed bad).
 */
export function expectedQualityFromEvidence(
  evidenceConfidences: readonly number[],
): number {
  if (evidenceConfidences.length === 0) return NEUTRAL_SIGNAL;
  const sum = evidenceConfidences.reduce((total, value) => total + value, 0);
  return round6(sum / evidenceConfidences.length);
}

/**
 * Prior contribution value: the source's answered count under a
 * saturating curve — has this source actually delivered useful knowledge
 * before, and how much. Zero contributions score exactly 0; the value
 * saturates as the contributions accumulate (past usefulness has
 * diminishing marginal value).
 */
export function priorContributionValueFromAnswers(answeredCount: number): number {
  return round6(answeredCount / (answeredCount + CONTRIBUTION_SATURATION));
}

/**
 * Recency/freshness: exponential decay from the source's latest answered
 * evidence — `0.5 ** (ageDays / FRESHNESS_HALF_LIFE_DAYS)`. A source
 * whose latest evidence was observed today scores 1; every half-life of
 * age halves it. No answered evidence (or none readable by the ranking
 * principal) → the neutral prior (recency unknown, not presumed stale).
 * Negative ages clamp to 0 days (evidence observed "in the future" per a
 * skewed source clock is treated as current, never as a bonus).
 */
export function freshnessFromLastEvidence(ageDays: number | null): number {
  if (ageDays === null) return NEUTRAL_SIGNAL;
  return round6(0.5 ** (Math.max(0, ageDays) / FRESHNESS_HALF_LIFE_DAYS));
}

/** Age in fractional days of an ISO-8601 instant, at the evaluation instant. */
export function ageInDays(observedAt: string, at: Date): number {
  return (at.getTime() - new Date(observedAt).getTime()) / 86_400_000;
}

// ---------------------------------------------------------------------------
// Transactive-memory signals (who knows / decides the subject)
// ---------------------------------------------------------------------------

/**
 * Semantic relevance: how strongly the source is on record, in transactive
 * memory, as knowing the mission's subject — the count of mission subject
 * topics covered by the union of the actor's entry topics, under a
 * saturating curve (`matched / (matched + RELEVANCE_SATURATION)`).
 *
 *   no entries (or a non-actor candidate kind)  → NEUTRAL (unknown)
 *   entries, none matching the subject          → 0 (evidence the actor's
 *                                                  knowledge lies elsewhere)
 *   one matching topic                           → NEUTRAL (a single shared
 *                                                  word is not yet relevance)
 *   each further matched topic                   → more, with saturation
 *
 * The asymmetry is deliberate: transactive memory that names the actor
 * next to OTHER subjects is evidence AGAINST relevance here, while the
 * absence of a transactive record is no evidence at all — employees and
 * systems therefore compete fairly, each on the evidence its kind can
 * actually accumulate.
 */
export function relevanceFromTransactive(
  missionTopics: readonly string[],
  entries: readonly SourceTransactiveEntrySnapshot[],
): number {
  if (entries.length === 0 || missionTopics.length === 0) return NEUTRAL_SIGNAL;
  const known = new Set<string>();
  for (const entry of entries) {
    for (const topic of entry.topics) known.add(topic);
  }
  let matched = 0;
  for (const topic of missionTopics) {
    if (known.has(topic)) matched += 1;
  }
  return round6(matched / (matched + RELEVANCE_SATURATION));
}

/**
 * Authority on the mission's subject: the strongest §7 relation the actor
 * holds among the transactive entries that match the subject (see
 * RELATION_AUTHORITY). Entries about other subjects do not grant
 * authority here; no matching entries (or no subject topics) → the
 * neutral prior. An actor who both knows and decides the subject is
 * ranked by the stronger relation.
 */
export function authorityFromTransactive(
  missionTopics: readonly string[],
  entries: readonly SourceTransactiveEntrySnapshot[],
): number {
  if (entries.length === 0 || missionTopics.length === 0) return NEUTRAL_SIGNAL;
  let authority: number | null = null;
  for (const entry of entries) {
    const matches = entry.topics.some((topic) => missionTopics.includes(topic));
    if (!matches) continue;
    const strength = RELATION_AUTHORITY[entry.relation];
    if (authority === null || strength > authority) authority = strength;
  }
  return authority === null ? NEUTRAL_SIGNAL : authority;
}

// ---------------------------------------------------------------------------
// The derivation
// ---------------------------------------------------------------------------

/** The six learned ADR-0018 signals this layer derives (cost/access are policy). */
export interface DerivedLearnedSignals {
  relevance: number;
  reliability: number;
  freshness: number;
  authority: number;
  expectedQuality: number;
  priorContributionValue: number;
}

/** The derivation result: the signals plus the basis that explains them. */
export interface DerivedSourceEvaluation {
  signals: DerivedLearnedSignals;
  basis: SourceEvidenceBasis;
}

/**
 * Derives one candidate's six learned signals from its evidence snapshot,
 * the mission's subject topics and the evaluation instant. Pure and
 * total: the same snapshot, topics and instant always produce the same
 * signals and the same basis — the basis records WHERE each value came
 * from (outcome counts, evidence confidence mean, latest evidence clock,
 * transactive entries consulted, matched topics, matching relations),
 * which is what makes a ranking that changed because the EVIDENCE
 * changed reconstructable from two persisted snapshots (ADR-0018's
 * required verification).
 */
export function deriveSourceSignals(
  missionTopics: readonly string[],
  evidence: SourceEvidenceSnapshot,
  evaluationAt: Date,
): DerivedSourceEvaluation {
  const confidenceMean =
    evidence.evidenceConfidences.length === 0
      ? null
      : expectedQualityFromEvidence(evidence.evidenceConfidences);

  const matchedTopics = new Set<string>();
  const matchingRelations = new Set<TransactiveRelation>();
  if (missionTopics.length > 0) {
    for (const entry of evidence.transactiveEntries) {
      let entryMatches = false;
      for (const topic of entry.topics) {
        if (missionTopics.includes(topic)) {
          matchedTopics.add(topic);
          entryMatches = true;
        }
      }
      if (entryMatches) matchingRelations.add(entry.relation);
    }
  }

  return {
    signals: {
      relevance: relevanceFromTransactive(missionTopics, evidence.transactiveEntries),
      reliability: reliabilityFromOutcomes(evidence.outcomes),
      freshness: freshnessFromLastEvidence(
        evidence.latestEvidenceObservedAt === null
          ? null
          : ageInDays(evidence.latestEvidenceObservedAt, evaluationAt),
      ),
      authority: authorityFromTransactive(missionTopics, evidence.transactiveEntries),
      expectedQuality: confidenceMean === null ? NEUTRAL_SIGNAL : confidenceMean,
      priorContributionValue: priorContributionValueFromAnswers(
        evidence.outcomes.answered,
      ),
    },
    basis: {
      outcomes: { ...evidence.outcomes },
      evidenceConfidenceMean: confidenceMean,
      latestEvidenceObservedAt: evidence.latestEvidenceObservedAt,
      transactiveEntryIds: evidence.transactiveEntries
        .map((entry) => entry.id)
        .sort(),
      matchedTopics: [...matchedTopics].sort(),
      relations: [...matchingRelations].sort(),
    },
  };
}

// ---------------------------------------------------------------------------
// Deterministic order of the derivation snapshot
// ---------------------------------------------------------------------------

/**
 * The total deterministic order of the persisted derivation snapshot —
 * identical in shape to the planner's orderRankedCandidates (ranking.ts):
 * score descending, then the §7 menu order of kinds, then the candidate
 * key ascending. The ranking record and the plan it produced therefore
 * present the same candidates in the same order, and diffs between two
 * ranking snapshots line up row by row.
 */
export function orderRankedSources(sources: RankedSource[]): RankedSource[] {
  const kindRank = new Map(
    CANDIDATE_KIND_ORDER.map((kind, index) => [kind, index] as const),
  );
  return [...sources].sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    const rankA = kindRank.get(a.candidate.kind) ?? CANDIDATE_KIND_ORDER.length;
    const rankB = kindRank.get(b.candidate.kind) ?? CANDIDATE_KIND_ORDER.length;
    if (rankA !== rankB) return rankA - rankB;
    return candidateKey(a.candidate) < candidateKey(b.candidate) ? -1 : 1;
  });
}
