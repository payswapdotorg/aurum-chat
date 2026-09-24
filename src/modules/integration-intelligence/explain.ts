// Pure why-it-matters logic of the integration-intelligence module (no
// database, no clock, no network, no LLM — deterministic by mandate).
//
// For each discovered system, W081 must "generate (deterministically, from
// the org's own goals/unknowns/gaps where available, else from the
// system's capability class) an outcome-oriented explanation of what
// connecting it would unlock — in plain organizational language, never
// provider jargon" (§10 UX: users see outcomes — quality, speed, cost,
// privacy, policy — not technology).
//
// Grounding algorithm (total, pure, tested):
//   1. Collect the system's matching keywords: every keyword of every one
//      of its capability classes, plus every keyword of every data
//      category those classes put in play (plus manifest-declared ones).
//   2. Tokenize each org record's text (lowercase words split on
//      non-alphanumerics). A keyword matches a token when they are equal,
//      or when the keyword is ≥ 4 chars and the token starts with it
//      (plural/inflection tolerance: "customers" carries "customer").
//   3. A goal / unknown / gap is GROUNDED when any keyword matches any
//      token of its text. Grounded records (≤ 3 of each kind, in input
//      order) are cited in the explanation; the first of each kind is
//      woven into the summary sentence.
//   4. `basis` is 'org-context' when anything grounded, else
//      'capability-class' (the fallback the mandate names).
//
// Output language is outcome-oriented by construction: summaries are
// assembled from registry `connectionLead` phrases, outcomes from registry
// §10-dimension statements. No provider, vendor or product name can appear
// — the vocabulary has none.

import { OUTCOME_DIMENSION_ORDER, capabilityClassOf, dataCategoryOf } from './vocabulary';
import type {
  ExplanationOrgContext,
  OutcomeDimension,
  WhyItMatters,
} from './types';

/** Max grounded records of each kind cited in `groundedIn`. */
const MAX_GROUNDED_PER_KIND = 3;

/** All matching keywords of a system's classes and data categories. */
export function keywordsForSystem(
  capabilityClasses: readonly string[],
  dataCategories: readonly string[],
): string[] {
  const keywords = new Set<string>();
  for (const classKey of capabilityClasses) {
    const entry = capabilityClassOf(classKey);
    if (entry === null) continue;
    for (const keyword of entry.keywords) keywords.add(keyword);
  }
  for (const categoryKey of dataCategories) {
    const entry = dataCategoryOf(categoryKey);
    if (entry === null) continue;
    for (const keyword of entry.keywords) keywords.add(keyword);
  }
  return [...keywords];
}

/** Lowercase word tokens of a text (split on anything non-alphanumeric). */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}

/** Does `keyword` match `token` (equal, or ≥4-char prefix for plurals)? */
export function keywordMatchesToken(keyword: string, token: string): boolean {
  if (token === keyword) return true;
  return keyword.length >= 4 && token.startsWith(keyword);
}

/** Does any keyword hit any token of `text`? */
export function textMatchesKeywords(text: string, keywords: readonly string[]): boolean {
  const tokens = tokenize(text);
  for (const keyword of keywords) {
    for (const token of tokens) {
      if (keywordMatchesToken(keyword, token)) return true;
    }
  }
  return false;
}

/** Deterministic 'a, b and c' join (Oxford-free; 1..n items). */
export function joinAnd(parts: readonly string[]): string {
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0]!;
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]!}`;
}

/** Strip trailing whitespace and trailing periods so quoted fragments embed cleanly. */
function trimSentence(text: string): string {
  return text.replace(/[.\s]+$/u, '');
}

/**
 * Generates the deterministic why-it-matters explanation for one system.
 * Pure: same system + same org context ⇒ same explanation, always.
 */
export function explainWhyItMatters(
  system: {
    displayName: string;
    capabilityClasses: readonly string[];
    dataCategories: readonly string[];
  },
  orgContext: ExplanationOrgContext,
): WhyItMatters {
  const keywords = keywordsForSystem(system.capabilityClasses, system.dataCategories);

  // Grounding (input order preserved — determinism).
  const matchedGoals = orgContext.goals.filter((goal) =>
    textMatchesKeywords(`${goal.title} ${goal.text}`, keywords),
  );
  const matchedUnknowns = orgContext.unknowns.filter((unknown) =>
    textMatchesKeywords(`${unknown.question} ${unknown.text}`, keywords),
  );
  const matchedGaps = orgContext.gaps.filter((gap) =>
    textMatchesKeywords(gap.capabilityName, keywords),
  );

  // Outcomes: registry statements across the system's classes, deduped by
  // (dimension, text), canonically ordered by §10 dimension then first-seen.
  const seen = new Set<string>();
  const collected: { dimension: OutcomeDimension; text: string }[] = [];
  for (const classKey of system.capabilityClasses) {
    const entry = capabilityClassOf(classKey);
    if (entry === null) continue;
    for (const outcome of entry.outcomes) {
      const identity = `${outcome.dimension}:${outcome.text}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      collected.push({ dimension: outcome.dimension, text: outcome.text });
    }
  }
  collected.sort((a, b) => {
    const dimensionRank =
      OUTCOME_DIMENSION_ORDER.indexOf(a.dimension) - OUTCOME_DIMENSION_ORDER.indexOf(b.dimension);
    if (dimensionRank !== 0) return dimensionRank;
    return a.text < b.text ? -1 : a.text > b.text ? 1 : 0;
  });

  // Summary: lead sentence from the classes' connection leads, then at
  // most one grounding sentence per kind (first match each).
  const leads = system.capabilityClasses
    .map((classKey) => capabilityClassOf(classKey)?.connectionLead)
    .filter((lead): lead is string => typeof lead === 'string');
  const parts: string[] = [];
  parts.push(`Connecting ${system.displayName} would let Aurum ${joinAnd(leads)}.`);
  const goal = matchedGoals[0];
  if (goal !== undefined) parts.push(`This would help with your goal "${trimSentence(goal.title)}".`);
  const unknown = matchedUnknowns[0];
  if (unknown !== undefined) {
    parts.push(`It could also help answer the open question "${trimSentence(unknown.question)}".`);
  }
  const gap = matchedGaps[0];
  if (gap !== undefined) {
    parts.push(`And it could help close the capability gap "${trimSentence(gap.capabilityName)}".`);
  }

  return {
    basis: matchedGoals.length + matchedUnknowns.length + matchedGaps.length > 0
      ? 'org-context'
      : 'capability-class',
    summary: parts.join(' '),
    outcomes: collected,
    groundedIn: {
      goals: matchedGoals.slice(0, MAX_GROUNDED_PER_KIND).map((goal) => ({ id: goal.id, title: goal.title })),
      unknowns: matchedUnknowns
        .slice(0, MAX_GROUNDED_PER_KIND)
        .map((unknown) => ({ id: unknown.id, question: unknown.question })),
      gaps: matchedGaps
        .slice(0, MAX_GROUNDED_PER_KIND)
        .map((gap) => ({ capabilityId: gap.capabilityId, capabilityName: gap.capabilityName })),
    },
  };
}
