// Pure recommendation logic of the integration-intelligence module (no
// database, no clock, no network — deterministic by mandate).
//
// W081 recommendations are "ranked, safe-by-default connection proposals
// with explicit scope impact (what would be read, what stays write-gated),
// suitable for bulk approval":
//
//   * SAFE BY DEFAULT — every W081 proposal is READ-ONLY. Write authority
//     is never bundled into a connection proposal; it belongs to W083's
//     ask-exactly-when-a-task-requires-it path (§10 progressive authority:
//     observe/read → recommend → ask → execute).
//
//   * SCOPE IMPACT — derived mechanically from the system's capability
//     surface: the read capabilities are "what would be read" (with the
//     data categories each touches), the write capabilities are "what
//     stays write-gated".
//
//   * RANKING — a deterministic value score:
//
//       score = 10 × grounded goals
//             +  5 × grounded unknowns
//             +  5 × grounded capability gaps
//             +  2 × capability classes
//             +  1 × data categories
//
//     Goals weigh most (explicit management direction, W008), unknowns and
//     gaps half as much (first-class epistemics, lock 7, and the W017 gap
//     chain), breadth terms break ties toward wider surfaces. Ordering is
//     score DESC, then system_key ASC — fully deterministic, no clock, no
//     randomness, no LLM (lock 10 discipline: derived intelligence is a
//     pure function of current state).

import { deriveCapabilitySurface } from './discovery';
import { explainWhyItMatters, keywordsForSystem } from './explain';
import type { ExplanationOrgContext, ScopeImpact, WhyItMatters } from './types';

/** Weights of the deterministic ranking formula (see file header). */
export const SCORE_WEIGHTS = {
  groundedGoal: 10,
  groundedUnknown: 5,
  groundedGap: 5,
  capabilityClass: 2,
  dataCategory: 1,
} as const;

/** The deterministic value score of one proposed connection. */
export function scoreRecommendation(
  system: {
    capabilityClasses: readonly string[];
    dataCategories: readonly string[];
  },
  orgContext: ExplanationOrgContext,
): number {
  const keywords = keywordsForSystem(system.capabilityClasses, system.dataCategories);
  const goals = orgContext.goals.filter((goal) =>
    textMatches(`${goal.title} ${goal.text}`, keywords),
  ).length;
  const unknowns = orgContext.unknowns.filter((unknown) =>
    textMatches(`${unknown.question} ${unknown.text}`, keywords),
  ).length;
  const gaps = orgContext.gaps.filter((gap) => textMatches(gap.capabilityName, keywords)).length;
  return (
    SCORE_WEIGHTS.groundedGoal * goals +
    SCORE_WEIGHTS.groundedUnknown * unknowns +
    SCORE_WEIGHTS.groundedGap * gaps +
    SCORE_WEIGHTS.capabilityClass * system.capabilityClasses.length +
    SCORE_WEIGHTS.dataCategory * system.dataCategories.length
  );
}

function textMatches(text: string, keywords: readonly string[]): boolean {
  // Local re-implementation to keep recommend.ts import-light; identical
  // semantics to explain.ts's textMatchesKeywords (unit-tested equality).
  const tokens = text.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 0);
  for (const keyword of keywords) {
    for (const token of tokens) {
      if (token === keyword || (keyword.length >= 4 && token.startsWith(keyword))) return true;
    }
  }
  return false;
}

/** Derives the explicit scope impact of connecting a system (read-only). */
export function scopeImpactOf(system: {
  capabilityClasses: readonly string[];
  dataCategories: readonly string[];
}): ScopeImpact {
  const surface = deriveCapabilitySurface(system.capabilityClasses);
  return {
    connectionMode: 'read-only',
    wouldRead: surface
      .filter((capability) => capability.mode === 'read')
      .map((capability) => ({
        key: capability.key,
        label: capability.label,
        dataCategories: [...capability.dataCategories],
      })),
    staysWriteGated: surface
      .filter((capability) => capability.mode === 'write')
      .map((capability) => ({ key: capability.key, label: capability.label })),
    dataCategories: [...system.dataCategories],
  };
}

/** Everything a new recommendation row needs, derived deterministically. */
export interface RecommendationDraft {
  whyItMatters: WhyItMatters;
  scopeImpact: ScopeImpact;
  score: number;
}

/** Builds one recommendation's frozen content (explanation + scope + score). */
export function buildRecommendationDraft(
  system: {
    displayName: string;
    capabilityClasses: readonly string[];
    dataCategories: readonly string[];
  },
  orgContext: ExplanationOrgContext,
): RecommendationDraft {
  return {
    whyItMatters: explainWhyItMatters(system, orgContext),
    scopeImpact: scopeImpactOf(system),
    score: scoreRecommendation(system, orgContext),
  };
}
