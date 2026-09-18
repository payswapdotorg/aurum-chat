// Unit tests for the pure W052 source-evidence → signal derivation
// (source-ranking.ts — no database, no context; the ranking.ts unit-test
// precedent). These pin the DERIVATION semantics ADR-0018 binds:
//
//  * the mission subject topics are a deterministic tokenization of the
//    mission's title + knowledge objective (content words, stopwords
//    dropped, first-occurrence order, capped);
//  * each learned signal is a total, deterministic function of the
//    source's evidence — reliability (Laplace-smoothed answered share),
//    expected quality (evidence confidence mean), prior contribution
//    value (saturating answered count), freshness (half-life decay from
//    the latest answered evidence), relevance (saturating topic matches
//    against transactive memory, neutral without a record) and authority
//    (strongest matching §7 relation, neutral without a match);
//  * the neutral priors: no history / no record / no subject is neutral,
//    never zero — evidence of absence only where the record actually
//    says so;
//  * deriveSourceSignals composes them into the full signal vector plus
//    the basis that explains every value (the persisted rationale);
//  * orderRankedSources is the same total deterministic order as the
//    planner's orderRankedCandidates;
//  * determinism: identical evidence, topics and instant produce
//    identical signals, basis and order — the "same learned state, same
//    ordering" property ADR-0018 requires.

import { describe, expect, it } from 'vitest';
import type { TransactiveRelation } from '@/modules/memory/contract';
import {
  ageInDays,
  authorityFromTransactive,
  deriveSourceSignals,
  expectedQualityFromEvidence,
  freshnessFromLastEvidence,
  missionSubjectTopics,
  NEUTRAL_SIGNAL,
  orderRankedSources,
  priorContributionValueFromAnswers,
  relevanceFromTransactive,
  reliabilityFromOutcomes,
  RELATION_AUTHORITY,
} from '../source-ranking';
import type {
  RankedSource,
  SourceEvidenceSnapshot,
  SourceTransactiveEntrySnapshot,
} from '../types';

const EVALUATION_AT = new Date('2026-09-14T12:00:00.000Z');

/** An empty evidence snapshot: nothing learned about the source. */
function noEvidence(): SourceEvidenceSnapshot {
  return {
    outcomes: { answered: 0, unavailable: 0, failed: 0 },
    evidenceConfidences: [],
    latestEvidenceObservedAt: null,
    transactiveEntries: [],
  };
}

function entry(
  id: string,
  relation: TransactiveRelation,
  topics: string[],
): SourceTransactiveEntrySnapshot {
  return { id, relation, topics };
}

// ---------------------------------------------------------------------------
// missionSubjectTopics
// ---------------------------------------------------------------------------

describe('missionSubjectTopics', () => {
  it('extracts the content words of title + objective, title first', () => {
    expect(
      missionSubjectTopics(
        'Churn root cause',
        'Why did churn rise in Q3 and what is the dominant driver?',
      ),
    ).toEqual(['churn', 'root', 'cause', 'rise', 'q3', 'dominant', 'driver']);
  });

  it('drops stopwords, single letters, punctuation and duplicates (deterministic)', () => {
    const once = missionSubjectTopics('Pricing', 'What is the pricing of the pricing?');
    const twice = missionSubjectTopics('Pricing pricing!', 'What is the pricing of the pricing?');
    expect(once).toEqual(['pricing']);
    expect(twice).toEqual(once);
  });

  it('caps the topics at MISSION_TOPIC_CAP in first-occurrence order', () => {
    const words = Array.from({ length: 30 }, (_, i) => `topic${i + 1}`);
    const topics = missionSubjectTopics(words.join(' '), 'irrelevant');
    expect(topics).toHaveLength(16);
    expect(topics).toEqual(words.slice(0, 16));
  });

  it('yields no topics when the text is all grammar words', () => {
    expect(missionSubjectTopics('What is it?', 'Who can do the what?')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Outcome-history signals
// ---------------------------------------------------------------------------

describe('reliabilityFromOutcomes', () => {
  it('is the Laplace-smoothed answered share', () => {
    expect(reliabilityFromOutcomes({ answered: 4, unavailable: 0, failed: 0 })).toBeCloseTo(5 / 6, 6);
    expect(reliabilityFromOutcomes({ answered: 2, unavailable: 1, failed: 1 })).toBeCloseTo(3 / 6, 6);
    expect(reliabilityFromOutcomes({ answered: 0, unavailable: 0, failed: 3 })).toBeCloseTo(1 / 5, 6);
  });

  it('sits exactly at the neutral prior with no history (neither trusted nor distrusted)', () => {
    expect(reliabilityFromOutcomes({ answered: 0, unavailable: 0, failed: 0 })).toBe(NEUTRAL_SIGNAL);
  });

  it('is a pure function — identical counts produce identical values', () => {
    const counts = { answered: 3, unavailable: 2, failed: 5 };
    expect(reliabilityFromOutcomes(counts)).toBe(reliabilityFromOutcomes(counts));
  });
});

describe('expectedQualityFromEvidence', () => {
  it('is the mean of the answered evidence confidences', () => {
    expect(expectedQualityFromEvidence([0.8, 0.6, 0.7])).toBeCloseTo(0.7, 6);
    expect(expectedQualityFromEvidence([0.9])).toBe(0.9);
  });

  it('is neutral with no readable evidence (unknown, not presumed bad)', () => {
    expect(expectedQualityFromEvidence([])).toBe(NEUTRAL_SIGNAL);
  });
});

describe('priorContributionValueFromAnswers', () => {
  it('saturates with the answered count (half value at CONTRIBUTION_SATURATION)', () => {
    expect(priorContributionValueFromAnswers(0)).toBe(0);
    expect(priorContributionValueFromAnswers(4)).toBeCloseTo(0.5, 6);
    expect(priorContributionValueFromAnswers(16)).toBeCloseTo(0.8, 6);
    expect(priorContributionValueFromAnswers(16)).toBeGreaterThan(
      priorContributionValueFromAnswers(4),
    );
  });

  it('scores a never-contributing source exactly 0 — the value of nothing is nothing', () => {
    expect(priorContributionValueFromAnswers(0)).toBe(0);
  });
});

describe('freshnessFromLastEvidence', () => {
  it('decays by half every FRESHNESS_HALF_LIFE_DAYS of evidence age', () => {
    expect(freshnessFromLastEvidence(0)).toBe(1);
    expect(freshnessFromLastEvidence(30)).toBeCloseTo(0.5, 6);
    expect(freshnessFromLastEvidence(60)).toBeCloseTo(0.25, 6);
    expect(freshnessFromLastEvidence(90)).toBeCloseTo(0.125, 6);
  });

  it('is neutral with no answered evidence (recency unknown, not presumed stale)', () => {
    expect(freshnessFromLastEvidence(null)).toBe(NEUTRAL_SIGNAL);
  });

  it('clamps negative ages to now (a skewed source clock is current, never a bonus)', () => {
    expect(freshnessFromLastEvidence(-7)).toBe(1);
  });

  it('ageInDays measures fractional days from the evidence clock to the instant', () => {
    expect(ageInDays('2026-09-14T12:00:00.000Z', EVALUATION_AT)).toBe(0);
    expect(ageInDays('2026-08-15T12:00:00.000Z', EVALUATION_AT)).toBeCloseTo(30, 9);
  });
});

// ---------------------------------------------------------------------------
// Transactive-memory signals
// ---------------------------------------------------------------------------

describe('relevanceFromTransactive', () => {
  const topics = ['churn', 'pricing', 'q3'];

  it('saturates in the number of matched mission topics', () => {
    expect(
      relevanceFromTransactive(topics, [entry('e1', 'knows', ['churn'])]),
    ).toBeCloseTo(1 / 2, 6); // one match ≈ the neutral prior
    expect(
      relevanceFromTransactive(topics, [entry('e1', 'knows', ['churn', 'pricing'])]),
    ).toBeCloseTo(2 / 3, 6);
    expect(
      relevanceFromTransactive(topics, [entry('e1', 'knows', ['churn', 'pricing', 'q3'])]),
    ).toBeCloseTo(3 / 4, 6);
  });

  it('unions the topics across the actor\u2019s entries', () => {
    expect(
      relevanceFromTransactive(
        topics,
        [entry('e1', 'knows', ['churn']), entry('e2', 'owns', ['pricing'])],
      ),
    ).toBeCloseTo(2 / 3, 6);
  });

  it('is 0 when the record shows the actor\u2019s knowledge lies elsewhere (evidence of irrelevance)', () => {
    expect(relevanceFromTransactive(topics, [entry('e1', 'knows', ['office-supplies'])])).toBe(0);
  });

  it('is neutral without a transactive record (no record is no evidence)', () => {
    expect(relevanceFromTransactive(topics, [])).toBe(NEUTRAL_SIGNAL);
  });

  it('is neutral when the mission has no subject topics (no relevance judgement)', () => {
    expect(relevanceFromTransactive([], [entry('e1', 'knows', ['churn'])])).toBe(NEUTRAL_SIGNAL);
  });
});

describe('authorityFromTransactive', () => {
  const topics = ['churn', 'pricing'];

  it('takes the strongest matching relation (RELATION_AUTHORITY)', () => {
    expect(authorityFromTransactive(topics, [entry('e1', 'knows', ['churn'])])).toBe(
      RELATION_AUTHORITY.knows,
    );
    expect(
      authorityFromTransactive(topics, [
        entry('e1', 'knows', ['churn']),
        entry('e2', 'decides', ['pricing']),
      ]),
    ).toBe(RELATION_AUTHORITY.decides);
  });

  it('ignores entries about other subjects — authority is on the mission\u2019s subject', () => {
    expect(
      authorityFromTransactive(topics, [entry('e1', 'decides', ['office-supplies'])]),
    ).toBe(NEUTRAL_SIGNAL);
  });

  it('is neutral with no record and with no mission topics', () => {
    expect(authorityFromTransactive(topics, [])).toBe(NEUTRAL_SIGNAL);
    expect(authorityFromTransactive([], [entry('e1', 'decides', ['churn'])])).toBe(NEUTRAL_SIGNAL);
  });

  it('pins the §7 relation strength order (policy, not measurement)', () => {
    expect(RELATION_AUTHORITY.decides).toBeGreaterThan(RELATION_AUTHORITY.owns);
    expect(RELATION_AUTHORITY.owns).toBeGreaterThan(RELATION_AUTHORITY.can_perform);
    expect(RELATION_AUTHORITY.can_perform).toBeGreaterThan(RELATION_AUTHORITY.knows);
    expect(RELATION_AUTHORITY.knows).toBeGreaterThan(RELATION_AUTHORITY.has_experience_with);
    expect(RELATION_AUTHORITY.has_experience_with).toBeGreaterThan(RELATION_AUTHORITY.influences);
  });
});

// ---------------------------------------------------------------------------
// deriveSourceSignals — the composition + the basis
// ---------------------------------------------------------------------------

describe('deriveSourceSignals', () => {
  it('derives the full learned vector and the basis that explains every value', () => {
    const evidence: SourceEvidenceSnapshot = {
      outcomes: { answered: 2, unavailable: 1, failed: 1 },
      evidenceConfidences: [0.8, 0.6],
      latestEvidenceObservedAt: '2026-08-15T12:00:00.000Z', // 30 days before EVALUATION_AT
      transactiveEntries: [
        entry('e2', 'knows', ['pricing']),
        entry('e1', 'decides', ['churn']),
      ],
    };
    const missionTopics = ['churn', 'pricing'];

    const { signals, basis } = deriveSourceSignals(missionTopics, evidence, EVALUATION_AT);

    expect(signals).toEqual({
      relevance: 0.666667, // rounded to the persisted 6-decimal granularity
      reliability: 0.5,
      freshness: 0.5, // exactly one half-life old
      authority: RELATION_AUTHORITY.decides,
      expectedQuality: 0.7,
      priorContributionValue: 0.333333,
    });
    // The basis is the persisted rationale: which counts, which mean,
    // which clock, which entries, which matches, which relations.
    expect(basis).toEqual({
      outcomes: { answered: 2, unavailable: 1, failed: 1 },
      evidenceConfidenceMean: 0.7,
      latestEvidenceObservedAt: '2026-08-15T12:00:00.000Z',
      transactiveEntryIds: ['e1', 'e2'], // sorted, not insertion order
      matchedTopics: ['churn', 'pricing'], // sorted
      relations: ['decides', 'knows'], // sorted
    });
  });

  it('maps nothing learned onto the neutral priors with an all-zero basis', () => {
    const { signals, basis } = deriveSourceSignals(['churn'], noEvidence(), EVALUATION_AT);
    expect(signals).toEqual({
      relevance: NEUTRAL_SIGNAL,
      reliability: NEUTRAL_SIGNAL,
      freshness: NEUTRAL_SIGNAL,
      authority: NEUTRAL_SIGNAL,
      expectedQuality: NEUTRAL_SIGNAL,
      priorContributionValue: 0, // the value of nothing is nothing
    });
    expect(basis).toEqual({
      outcomes: { answered: 0, unavailable: 0, failed: 0 },
      evidenceConfidenceMean: null,
      latestEvidenceObservedAt: null,
      transactiveEntryIds: [],
      matchedTopics: [],
      relations: [],
    });
  });

  it('is deterministic: identical inputs produce identical signals, basis and order', () => {
    const evidence: SourceEvidenceSnapshot = {
      outcomes: { answered: 1, unavailable: 0, failed: 2 },
      evidenceConfidences: [0.75],
      latestEvidenceObservedAt: '2026-09-01T00:00:00.000Z',
      transactiveEntries: [entry('e1', 'owns', ['churn'])],
    };
    const first = deriveSourceSignals(['churn'], evidence, EVALUATION_AT);
    const second = deriveSourceSignals(['churn'], evidence, EVALUATION_AT);
    expect(first).toEqual(second);
  });

  it('moves exactly one signal when exactly one piece of evidence changes (ADR-0018 verification shape)', () => {
    const topics = ['churn', 'pricing'];
    const before: SourceEvidenceSnapshot = {
      outcomes: { answered: 2, unavailable: 0, failed: 0 },
      evidenceConfidences: [0.8, 0.8],
      latestEvidenceObservedAt: '2026-09-14T00:00:00.000Z',
      transactiveEntries: [entry('e1', 'knows', ['churn', 'pricing'])],
    };
    // The source fails twice more: only reliability (and its basis counts) move.
    const after: SourceEvidenceSnapshot = {
      ...before,
      outcomes: { answered: 2, unavailable: 0, failed: 2 },
    };
    const a = deriveSourceSignals(topics, before, EVALUATION_AT);
    const b = deriveSourceSignals(topics, after, EVALUATION_AT);
    expect(b.signals.reliability).toBeLessThan(a.signals.reliability);
    expect(b.signals.relevance).toBe(a.signals.relevance);
    expect(b.signals.freshness).toBe(a.signals.freshness);
    expect(b.signals.authority).toBe(a.signals.authority);
    expect(b.signals.expectedQuality).toBe(a.signals.expectedQuality);
    expect(b.signals.priorContributionValue).toBe(a.signals.priorContributionValue);
    expect(b.basis.outcomes).toEqual({ answered: 2, unavailable: 0, failed: 2 });
    expect(a.basis.outcomes).toEqual({ answered: 2, unavailable: 0, failed: 0 });
    // everything else in the basis is unchanged
    expect(b.basis.evidenceConfidenceMean).toBe(a.basis.evidenceConfidenceMean);
    expect(b.basis.latestEvidenceObservedAt).toBe(a.basis.latestEvidenceObservedAt);
    expect(b.basis.matchedTopics).toEqual(a.basis.matchedTopics);
    expect(b.basis.relations).toEqual(a.basis.relations);
  });
});

// ---------------------------------------------------------------------------
// orderRankedSources
// ---------------------------------------------------------------------------

describe('orderRankedSources', () => {
  function ranked(
    kind: RankedSource['candidate']['kind'],
    key: string,
    score: number,
  ): RankedSource {
    return {
      candidate: { kind, id: null, label: key },
      signals: {
        relevance: 0.5,
        reliability: 0.5,
        freshness: 0.5,
        authority: 0.5,
        expectedQuality: 0.5,
        priorContributionValue: 0,
        cost: 0,
        access: 'allowed',
      },
      score,
      costShare: 0,
      dominantSignal: 'relevance',
      basis: {
        outcomes: { answered: 0, unavailable: 0, failed: 0 },
        evidenceConfidenceMean: null,
        latestEvidenceObservedAt: null,
        transactiveEntryIds: [],
        matchedTopics: [],
        relations: [],
      },
    };
  }

  it('orders by score desc, then the §7 kind order, then candidate key (the planner\u2019s order)', () => {
    const ordered = orderRankedSources([
      ranked('analysis', 'a', 0.5),
      ranked('system', 's', 0.5),
      ranked('person', 'p', 0.5),
      ranked('document', 'd', 0.6),
    ]);
    expect(ordered.map((source) => source.candidate)).toEqual([
      { kind: 'document', id: null, label: 'd' },
      { kind: 'person', id: null, label: 'p' },
      { kind: 'system', id: null, label: 's' },
      { kind: 'analysis', id: null, label: 'a' },
    ]);
  });

  it('breaks full ties by candidate key ascending and does not mutate the input', () => {
    const input = [ranked('system', 'b', 0.5), ranked('system', 'a', 0.5)];
    const ordered = orderRankedSources(input);
    expect(ordered.map((source) => source.candidate.label)).toEqual(['a', 'b']);
    expect(input.map((source) => source.candidate.label)).toEqual(['b', 'a']);
  });
});
