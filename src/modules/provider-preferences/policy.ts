// The pure, deterministic policy core of the provider-preferences
// module (W091) — no database, no clock, no network, no provider calls.
//
// Three computations, each unit-tested in isolation:
//
//   resolvePreferenceProfile — the fold of the tenant level and the
//      personal level into ONE effective outcome priority with its
//      plain-language source attribution. The precedence is the honest
//      one, in order: organizational policy (policy-first) → personal
//      preference → tenant priority → the documented balanced default.
//      A member's own choice leads the company's default (their
//      interactions are theirs) but NEVER organizational policy.
//
//   rankProviderCandidates — the deterministic application of an
//      outcome priority to a candidate list: compare on the first
//      outcome, tie-break on the next, and so on; missing signals are
//      unknown = worst; full ties fall back to input order (stability —
//      no provider is privileged by the ranker itself, lock 30). The
//      winner's deciding outcome (the one that separated it from the
//      runner-up) is returned for the explanation.
//
//   buildSelectionExplanation — the user-language "why this option?"
//      sentence builder. Every string it can produce is jargon-free by
//      construction: it is assembled ONLY from the structured decision
//      fields (decision, source, outcome, counts) — there is no code
//      path that interpolates a provider key, an account reference or
//      any other technical identity into an explanation. The
//      acceptance's first clause ("ordinary user never needs provider
//      jargon") is enforced HERE, not by UI discipline alone.
//
// WHY CALLER-NORMALIZED SIGNALS: the owning gateway knows what "cost",
// "speed", "quality" and "privacy" mean numerically for its providers
// (list price, measured latency, tier models). This module refuses to
// guess: it consumes comparable numbers where LOWER IS BETTER and
// applies the tenant's priority deterministically. A missing signal is
// honestly treated as unknown (worst) — never as good.

import type {
  PersonalPreference,
  PreferenceSource,
  ProviderCandidate,
  ProviderPreferenceOutcome,
  ResolvedPreferenceProfile,
  SelectionDecision,
  SelectionExplanationView,
  TenantPreference,
} from './types';
import { DEFAULT_OUTCOME_PRIORITY, PROVIDER_PREFERENCE_OUTCOMES } from './validation';

// ---------------------------------------------------------------------------
// resolvePreferenceProfile — the deterministic two-level fold
// ---------------------------------------------------------------------------

/**
 * The documented balanced default (applied when neither level is set):
 * quality and responsiveness first, then cost, then data-handling
 * posture. A DEFAULT, never a privilege — the first preference anyone
 * sets replaces it (lock 30: no provider is architecturally
 * privileged, and no outcome ordering is privileged either).
 */
export { DEFAULT_OUTCOME_PRIORITY };

/**
 * Fold the tenant level and the personal level into the effective
 * profile for one principal. Pure and total: null rows are legal
 * (nothing set yet).
 *
 * Precedence (the honest order):
 *   1. tenant.policyFirst  → the tenant's priority, source
 *      'organizational-policy' — company policy decides; the member's
 *      recorded preference does not bend routing while this holds.
 *   2. personal preference → the member's own priority, source
 *      'personal-preference'.
 *   3. tenant preference   → the company's priority, source
 *      'tenant-priority'.
 *   4. nothing set         → the documented balanced default, source
 *      'default'.
 */
export function resolvePreferenceProfile(
  tenant: Pick<TenantPreference, 'outcomePriority' | 'policyFirst'> | null,
  personal: Pick<PersonalPreference, 'outcomePriority'> | null,
): ResolvedPreferenceProfile {
  if (tenant !== null && tenant.policyFirst) {
    return {
      outcomePriority: [...tenant.outcomePriority],
      source: 'organizational-policy',
      policyFirst: true,
    };
  }
  if (personal !== null) {
    return {
      outcomePriority: [...personal.outcomePriority],
      source: 'personal-preference',
      policyFirst: tenant !== null && tenant.policyFirst,
    };
  }
  if (tenant !== null) {
    return {
      outcomePriority: [...tenant.outcomePriority],
      source: 'tenant-priority',
      policyFirst: false,
    };
  }
  return {
    outcomePriority: [...DEFAULT_OUTCOME_PRIORITY],
    source: 'default',
    policyFirst: false,
  };
}

// ---------------------------------------------------------------------------
// rankProviderCandidates — the deterministic outcome-priority ranker
// ---------------------------------------------------------------------------

/** One ranked candidate: the input candidate plus its final position. */
export interface RankedCandidate {
  candidate: ProviderCandidate;
  /** 1-based final position (1 = best under the priority). */
  position: number;
}

/** The deterministic ranking outcome of a candidate list. */
export interface CandidateRanking {
  /** Candidates ordered best-first (stable on full ties). */
  ordered: RankedCandidate[];
  /**
   * The outcome that separated the winner from the runner-up — the
   * honest "it won on X" of the explanation. Null when there was no
   * contest (fewer than two candidates) or the top two were fully tied
   * (input order decided; the explanation says so).
   */
  decidingOutcome: ProviderPreferenceOutcome | null;
}

/** The comparison signal of one candidate for one outcome (unknown = worst). */
function signalOf(candidate: ProviderCandidate, outcome: ProviderPreferenceOutcome): number {
  const value = candidate.outcomes[outcome];
  return typeof value === 'number' && Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
}

/**
 * Rank candidates under an outcome priority. Deterministic: compare on
 * the priority's outcomes in order; ties fall through to the next
 * outcome; a full tie preserves INPUT order (stability — the ranker
 * itself privileges nothing). Lower signal = better.
 */
export function rankProviderCandidates(
  candidates: readonly ProviderCandidate[],
  outcomePriority: readonly ProviderPreferenceOutcome[],
): CandidateRanking {
  const indexed = candidates.map((candidate, index) => ({ candidate, index }));
  const priority = [...outcomePriority];
  // Outcomes not named in the priority still break ties AFTER the
  // prioritized ones (deterministic completeness), in canonical order.
  for (const outcome of PROVIDER_PREFERENCE_OUTCOMES) {
    if (!priority.includes(outcome)) priority.push(outcome);
  }
  indexed.sort((left, right) => {
    for (const outcome of priority) {
      const delta = signalOf(left.candidate, outcome) - signalOf(right.candidate, outcome);
      if (delta !== 0) return delta;
    }
    return left.index - right.index;
  });
  const ordered: RankedCandidate[] = indexed.map((entry, position) => ({
    candidate: entry.candidate,
    position: position + 1,
  }));
  let decidingOutcome: ProviderPreferenceOutcome | null = null;
  if (ordered.length >= 2) {
    const [winner, runnerUp] = [ordered[0]!.candidate, ordered[1]!.candidate];
    for (const outcome of priority) {
      if (signalOf(winner, outcome) !== signalOf(runnerUp, outcome)) {
        decidingOutcome = outcome;
        break;
      }
    }
  }
  return { ordered, decidingOutcome };
}

// ---------------------------------------------------------------------------
// buildSelectionExplanation — the jargon-free sentence builder
// ---------------------------------------------------------------------------

/** User-language phrase of one outcome (what "better" means for it). */
export function outcomePhrase(outcome: ProviderPreferenceOutcome): string {
  switch (outcome) {
    case 'cost':
      return 'the lowest cost';
    case 'privacy':
      return 'the strongest data protection';
    case 'quality':
      return 'the highest quality';
    case 'speed':
      return 'the fastest response';
  }
}

/** User-language phrase of one preference source (whose priority held). */
export function preferenceSourcePhrase(source: PreferenceSource): string {
  switch (source) {
    case 'organizational-policy':
      return 'company policy decides';
    case 'tenant-priority':
      return 'your company set this priority';
    case 'personal-preference':
      return 'you set this priority';
    case 'default':
      return 'the balanced default applies';
  }
}

/** User-language label of one decision mechanism. */
export function selectionDecisionLabel(decision: SelectionDecision): string {
  switch (decision) {
    case 'technical-override':
      return 'an authorized override';
    case 'preference':
      return 'your priorities';
    case 'single-choice':
      return 'the only option available';
    case 'no-choice':
      return 'no option available';
  }
}

/** The structured inputs of `buildSelectionExplanation`. */
export interface SelectionExplanationInput {
  decision: SelectionDecision;
  preferenceSource: PreferenceSource;
  decidingOutcome: ProviderPreferenceOutcome | null;
  candidatesConsidered: number;
  budgetExcludedCount: number;
  overrideUnavailable: boolean;
}

/**
 * Build the user-language explanation of one provider selection.
 * JARGON-FREE BY CONSTRUCTION: the assembled sentence is a function of
 * the structured decision fields alone — provider keys, account
 * references and gateway identities have no path into the output.
 */
export function buildSelectionExplanation(input: SelectionExplanationInput): string {
  const others =
    input.candidatesConsidered > 1
      ? ` among ${input.candidatesConsidered} available options`
      : '';
  let sentence: string;
  switch (input.decision) {
    case 'no-choice':
      sentence =
        'No option was available, so nothing was chosen. This is recorded so you can see it happened.';
      break;
    case 'single-choice':
      sentence =
        'Only one option was available, so it was used. Your preferences still apply whenever more options exist.';
      break;
    case 'technical-override':
      sentence =
        'An authorized technical override chose this option. It can be reviewed and reversed in the advanced settings.';
      break;
    case 'preference': {
      const outcome =
        input.decidingOutcome === null ? null : outcomePhrase(input.decidingOutcome);
      const source = preferenceSourcePhrase(input.preferenceSource);
      if (outcome === null) {
        sentence = `The available options were equally matched, so the first available one was used (${source}).`;
      } else {
        switch (input.preferenceSource) {
          case 'personal-preference':
            sentence = `You asked for ${outcome} first — this option ranked best on that${others}.`;
            break;
          case 'tenant-priority':
            sentence = `${cap(source)} — this option ranked best on ${outcome}${others}.`;
            break;
          case 'organizational-policy':
            sentence = `Company policy decides how options are chosen — ${outcome} comes first, and this option ranked best among the options policy allows.`;
            break;
          case 'default':
            sentence = `No preference is set yet, so the balanced default applies — ${outcome} first — and this option ranked best on that${others}.`;
            break;
        }
      }
      break;
    }
  }
  if (input.overrideUnavailable) {
    sentence +=
      ' An authorized override names an option that was not available, so the preference chose instead.';
  }
  if (input.budgetExcludedCount > 0) {
    sentence += ` A spending limit set by your company excluded ${
      input.budgetExcludedCount === 1 ? 'one other option' : `${input.budgetExcludedCount} other options`
    }.`;
  }
  return sentence;
}

/** Capitalize the first letter (sentence assembly helper). */
function cap(text: string): string {
  return text.length === 0 ? text : `${text[0]!.toUpperCase()}${text.slice(1)}`;
}

/**
 * The ORDINARY view projection of a full explanation record — strips
 * the technical identity (provider, account reference, gateway,
 * tenant) so nothing jargon-bearing can reach a non-advanced surface.
 * Pure; used by the service on every ordinary read.
 */
export function toOrdinaryExplanationView(
  record: {
    id: string;
    capability: string;
    decision: SelectionDecision;
    preferenceSource: PreferenceSource;
    decidingOutcome: ProviderPreferenceOutcome | null;
    candidatesConsidered: number;
    budgetExcludedCount: number;
    overrideUnavailable: boolean;
    explanation: string;
    recordedAt: string;
  },
): SelectionExplanationView {
  return {
    id: record.id,
    capability: record.capability,
    decision: record.decision,
    preferenceSource: record.preferenceSource,
    decidingOutcome: record.decidingOutcome,
    candidatesConsidered: record.candidatesConsidered,
    budgetExcludedCount: record.budgetExcludedCount,
    overrideUnavailable: record.overrideUnavailable,
    explanation: record.explanation,
    occurredAt: record.recordedAt,
  };
}
