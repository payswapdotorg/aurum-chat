// Unit tests for the company-query module's PURE layer (W126): the frozen
// vocabularies, input validation, the conservative coverage derivation, the
// §6 step-7 materiality rule and the §7 honesty answers. No database —
// every input is a literal (the service-level integration tests live in
// company-query-service.test.ts).

import { describe, expect, it } from 'vitest';

import {
  COMPANY_CLAIM_KINDS,
  COMPANY_SURFACES,
  COVERAGE_STATES,
  DEFAULT_EVIDENCE_THRESHOLDS,
  answerCoverageQuestion,
  deriveCaveats,
  deriveMaterialGaps,
  deriveSurfaceCoverage,
  isCompanySurface,
  isCoverageQuestion,
  observationFreshness,
  surfacesForObservationKind,
  surfacesForQuestion,
} from '../contract';
import { validateCompanyQueryInput } from '../validation';
import { CompanyQueryError } from '../errors';
import type { CompanyCoverageSurfaceSummary } from '../types';

const AS_OF = '2026-10-04T12:00:00.000Z';
const THRESHOLDS = DEFAULT_EVIDENCE_THRESHOLDS;

// ---------------------------------------------------------------------------
// The frozen vocabularies (spec §3/§5 + §6 step 5)
// ---------------------------------------------------------------------------

describe('the coverage vocabularies', () => {
  it('carries the spec §3 surfaces, provider-neutral by construction', () => {
    // The architecture's own examples must all be representable.
    expect(COMPANY_SURFACES).toContain('customer-interactions');
    expect(COMPANY_SURFACES).toContain('support-tickets');
    expect(COMPANY_SURFACES).toContain('sales-opportunities');
    expect(COMPANY_SURFACES).toContain('projects-tasks');
    expect(COMPANY_SURFACES).toContain('meetings');
    expect(COMPANY_SURFACES).toContain('suppliers');
    expect(COMPANY_SURFACES).toContain('documents-knowledge');
    expect(COMPANY_SURFACES).toContain('people-organization');
    expect(COMPANY_SURFACES).toContain('external-environment');
    // No provider names leak into the surface vocabulary.
    for (const surface of COMPANY_SURFACES) {
      expect(surface).toMatch(/^[a-z]+(-[a-z]+)*$/);
      expect(['jira', 'zendesk', 'salesforce', 'slack', 'stripe']).not.toContain(surface);
    }
  });

  it('carries the spec §5 state vocabulary verbatim (seven states)', () => {
    expect([...COVERAGE_STATES]).toEqual([
      'covered',
      'partial',
      'stale',
      'unavailable',
      'unauthorized',
      'excluded',
      'unknown',
    ]);
  });

  it('carries the spec §6 step-5 epistemic split (four classes)', () => {
    expect([...COMPANY_CLAIM_KINDS]).toEqual([
      'observed-fact',
      'derived-belief',
      'hypothesis',
      'unknown',
    ]);
  });

  it('guards surface values totally', () => {
    expect(isCompanySurface('support-tickets')).toBe(true);
    expect(isCompanySurface('zendesk')).toBe(false);
    expect(isCompanySurface(null)).toBe(false);
    expect(isCompanySurface(42)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Input validation (§6 steps 1-2)
// ---------------------------------------------------------------------------

describe('validateCompanyQueryInput', () => {
  it('accepts a plain question and defaults the scope to every surface', () => {
    const valid = validateCompanyQueryInput({ question: '  What is our support backlog?  ' });
    expect(valid.question).toBe('What is our support backlog?');
    expect(valid.surfaces).toEqual(COMPANY_SURFACES);
  });

  it('accepts an explicit surface scope and canonicalizes its order', () => {
    const valid = validateCompanyQueryInput({
      question: 'Tickets?',
      surfaces: ['support-tickets', 'customer-interactions'],
    });
    expect(valid.surfaces).toEqual(['customer-interactions', 'support-tickets']);
  });

  it('rejects the malformed shapes with typed errors', () => {
    expect(() => validateCompanyQueryInput(null)).toThrow(CompanyQueryError);
    expect(() => validateCompanyQueryInput({})).toThrow(CompanyQueryError);
    expect(() => validateCompanyQueryInput({ question: '' })).toThrow(CompanyQueryError);
    expect(() => validateCompanyQueryInput({ question: '   ' })).toThrow(CompanyQueryError);
    expect(() => validateCompanyQueryInput({ question: 7 })).toThrow(CompanyQueryError);
    expect(() => validateCompanyQueryInput({ question: 'x'.repeat(2001) })).toThrow(CompanyQueryError);
    expect(() => validateCompanyQueryInput({ question: 'q', surfaces: [] })).toThrow(CompanyQueryError);
    expect(() => validateCompanyQueryInput({ question: 'q', surfaces: 'support-tickets' })).toThrow(
      CompanyQueryError,
    );
    expect(() => validateCompanyQueryInput({ question: 'q', surfaces: ['zendesk'] })).toThrow(
      CompanyQueryError,
    );
    expect(() =>
      validateCompanyQueryInput({ question: 'q', surfaces: ['meetings', 'meetings'] }),
    ).toThrow(CompanyQueryError);
    for (const invalid of [
      null,
      {},
      { question: '' },
      { question: '   ' },
      { question: 7 },
      { question: 'x'.repeat(2001) },
      { question: 'q', surfaces: [] },
      { question: 'q', surfaces: 'support-tickets' },
      { question: 'q', surfaces: ['zendesk'] },
      { question: 'q', surfaces: ['meetings', 'meetings'] },
    ]) {
      try {
        validateCompanyQueryInput(invalid);
        expect.unreachable('validation must reject');
      } catch (error) {
        expect(error).toBeInstanceOf(CompanyQueryError);
        expect((error as CompanyQueryError).code).toBe('invalid_query');
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Observation-kind classification (the §7 anti-"connected = captured" base)
// ---------------------------------------------------------------------------

describe('surfacesForObservationKind', () => {
  it('maps the canonical adapter kinds onto the semantic surfaces', () => {
    expect(surfacesForObservationKind('support.ticket.created')).toEqual(['support-tickets']);
    expect(surfacesForObservationKind('crm.deal.updated')).toEqual(['sales-opportunities']);
    expect(surfacesForObservationKind('issue.closed')).toEqual(['projects-tasks']);
    expect(surfacesForObservationKind('invoice.paid')).toEqual(['finance']);
    expect(surfacesForObservationKind('document.updated')).toEqual(['documents-knowledge']);
    expect(surfacesForObservationKind('calendar.event')).toEqual(['meetings']);
    expect(surfacesForObservationKind('channel.message')).toEqual(['customer-interactions']);
    expect(surfacesForObservationKind('freshness.sample')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The conservative coverage derivation (§4/§5)
// ---------------------------------------------------------------------------

/** A full-surface census from a sparse literal (everything else 0). */
function census(counts: Partial<Record<string, number>>, total?: number) {
  const countsBySurface = Object.fromEntries(
    COMPANY_SURFACES.map((surface) => [surface, counts[surface] ?? 0]),
  ) as Record<(typeof COMPANY_SURFACES)[number], number>;
  const summed = Object.values(countsBySurface).reduce((a, b) => a + b, 0);
  return { countsBySurface, total: total ?? summed };
}

function derivation(overrides: Partial<Parameters<typeof deriveSurfaceCoverage>[0]> = {}) {
  return deriveSurfaceCoverage({
    surfaces: ['support-tickets', 'meetings', 'sales-opportunities'],
    sources: [],
    evidence: census({}),
    asOf: AS_OF,
    thresholds: THRESHOLDS,
    ...overrides,
  });
}

describe('deriveSurfaceCoverage', () => {
  it('a surface with no connected source is unavailable, and its gap is "missing"', () => {
    const summaries = derivation();
    const support = summaries.find((summary) => summary.surface === 'support-tickets')!;
    expect(support.state).toBe('unavailable');
    expect(support.contributingSources).toEqual([]);
    expect(support.explanation).toContain('no authorized source');
  });

  it('a CONFIGURED source with no evidence is unknown — never covered (§7)', () => {
    const summaries = derivation({
      sources: [
        {
          sourceId: 's1',
          sourceModule: 'source',
          provider: 'zendesk',
          displayName: 'Zendesk prod',
          status: 'active',
          latestObservation: null,
          oauthExpiresAt: null,
        },
      ],
    });
    const support = summaries.find((summary) => summary.surface === 'support-tickets')!;
    expect(support.state).toBe('unknown');
    expect(support.explanation).toContain('connected does not mean captured');
    expect(support.contributingSources).toHaveLength(1);
    expect(support.contributingSources[0]!.displayName).toBe('Zendesk prod');
    expect(support.contributingSources[0]!.freshness).toBe('unknown');
  });

  it('stale evidence yields the stale state and a stale caveat', () => {
    const summaries = derivation({
      sources: [
        {
          sourceId: 's1',
          sourceModule: 'source',
          provider: 'zendesk',
          displayName: 'Zendesk prod',
          status: 'active',
          latestObservation: { observedAt: '2026-08-01T00:00:00.000Z' }, // > 30d old
          oauthExpiresAt: null,
        },
      ],
      evidence: census({ 'support-tickets': 40 }, 40),
    });
    const support = summaries.find((summary) => summary.surface === 'support-tickets')!;
    expect(support.state).toBe('stale');
    expect(support.latestObservedAt).toBe('2026-08-01T00:00:00.000Z');
    expect(deriveCaveats(summaries)[0]).toContain('support tickets evidence is stale');
  });

  it('fresh evidence with a healthy census is covered; a thin census is partial', () => {
    const fresh = { observedAt: '2026-10-02T00:00:00.000Z' };
    const source = {
      sourceId: 's1',
      sourceModule: 'source' as const,
      provider: 'zendesk' as const,
      displayName: 'Zendesk prod',
      status: 'active' as const,
      latestObservation: fresh,
      oauthExpiresAt: null,
    };
    const covered = derivation({
      sources: [source],
      evidence: census({ 'support-tickets': 12 }, 12),
    });
    expect(covered.find((summary) => summary.surface === 'support-tickets')!.state).toBe('covered');

    const partial = derivation({
      sources: [source],
      evidence: census({ 'support-tickets': 2 }, 2),
    });
    expect(partial.find((summary) => summary.surface === 'support-tickets')!.state).toBe('partial');
  });

  it('a lapsed OAuth grant is unauthorized (§5), with the caveat spelled out', () => {
    const summaries = derivation({
      sources: [
        {
          sourceId: 's1',
          sourceModule: 'source',
          provider: 'zendesk',
          displayName: 'Zendesk prod',
          status: 'active',
          latestObservation: { observedAt: '2026-10-02T00:00:00.000Z' },
          oauthExpiresAt: '2026-10-01T00:00:00.000Z', // before asOf
        },
      ],
      evidence: census({ 'support-tickets': 12 }, 12),
    });
    const support = summaries.find((summary) => summary.surface === 'support-tickets')!;
    expect(support.state).toBe('unauthorized');
    expect(deriveCaveats(summaries).join(' ')).toContain('authorization has lapsed');
  });

  it('disabled contributors make the surface unavailable without claiming authorization issues', () => {
    const summaries = derivation({
      sources: [
        {
          sourceId: 's1',
          sourceModule: 'source',
          provider: 'zendesk',
          displayName: 'Zendesk prod',
          status: 'disabled',
          latestObservation: { observedAt: '2026-10-02T00:00:00.000Z' },
          oauthExpiresAt: null,
        },
      ],
      evidence: census({ 'support-tickets': 12 }, 12),
    });
    const support = summaries.find((summary) => summary.surface === 'support-tickets')!;
    expect(support.state).toBe('unavailable');
    expect(support.explanation).toContain('all disabled');
  });

  it('classifies evidence age through the freshness contract vocabulary', () => {
    expect(observationFreshness({ observedAt: '2026-10-04T00:00:00.000Z' }, AS_OF, THRESHOLDS)).toBe('current');
    expect(observationFreshness({ observedAt: '2026-09-20T00:00:00.000Z' }, AS_OF, THRESHOLDS)).toBe('aging');
    expect(observationFreshness({ observedAt: '2026-08-01T00:00:00.000Z' }, AS_OF, THRESHOLDS)).toBe('stale');
    expect(observationFreshness(null, AS_OF, THRESHOLDS)).toBe('unknown');
    expect(observationFreshness({ observedAt: '2026-10-04T00:00:00.000Z' }, AS_OF, null)).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// Question → surface materiality (§6 step 7)
// ---------------------------------------------------------------------------

describe('surfacesForQuestion + deriveMaterialGaps', () => {
  it('names the surfaces a question is about (word-boundary matching)', () => {
    expect(surfacesForQuestion('How many open support tickets do we have?')).toEqual([
      'support-tickets',
    ]);
    expect(surfacesForQuestion('Which meetings from the last 30 days are represented?')).toEqual([
      'meetings',
    ]);
    expect(surfacesForQuestion('What is our revenue forecast and pipeline health?')).toEqual([
      'sales-opportunities',
    ]);
    expect(surfacesForQuestion('Tell me about the company')).toEqual([]);
  });

  function summary(
    surface: string,
    state: CompanyCoverageSurfaceSummary['state'],
    count = 0,
    contributors = 0,
  ): CompanyCoverageSurfaceSummary {
    return {
      surface: surface as CompanyCoverageSurfaceSummary['surface'],
      state,
      contributingSources: Array.from({ length: contributors }, (_, index) => ({
        sourceId: `s${index}`,
        sourceModule: 'source',
        provider: 'zendesk',
        displayName: `Source ${index}`,
        status: 'active',
        latestObservedAt: null,
        freshness: 'unknown',
      })),
      latestObservedAt: null,
      observationCount: count,
      explanation: 'fixture explanation',
    };
  }

  it('a gap on a surface the question NAMES is material with a why', () => {
    const gaps = deriveMaterialGaps('How many open support tickets do we have?', [
      summary('support-tickets', 'unavailable'),
      summary('meetings', 'unavailable'),
    ]);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.surface).toBe('support-tickets');
    expect(gaps[0]!.kind).toBe('missing');
    expect(gaps[0]!.why).toContain('could change the answer');
  });

  it('for a broad question only the nothing-at-all surfaces are material', () => {
    const gaps = deriveMaterialGaps('Tell me about the company', [
      summary('support-tickets', 'unavailable', 0, 0),
      summary('meetings', 'partial', 3, 1), // active-but-thin: caveat, not headline
    ]);
    expect(gaps.map((gap) => gap.surface)).toEqual(['support-tickets']);
  });

  it('covered surfaces never produce gaps', () => {
    expect(deriveMaterialGaps('All the support tickets?', [summary('support-tickets', 'covered', 40, 1)])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The §7 honesty answers
// ---------------------------------------------------------------------------

describe('the §7 honesty answers', () => {
  it('recognizes the spec\'s own coverage-question phrasings', () => {
    expect(isCoverageQuestion('How much of our customer support history can you see?')).toBe(true);
    expect(isCoverageQuestion('Which meetings from the last 30 days are represented?')).toBe(false);
    expect(isCoverageQuestion('Can you see every ticket in Zendesk?')).toBe(true);
    expect(isCoverageQuestion('What can you see about our customers?')).toBe(true);
    expect(isCoverageQuestion('What is our revenue?')).toBe(false);
  });

  it('answers from the derived state with no universality claim', () => {
    const answer = answerCoverageQuestion(
      'How much of our customer support history can you see?',
      [
        {
          surface: 'support-tickets',
          state: 'partial',
          contributingSources: [
            {
              sourceId: 's1',
              sourceModule: 'source',
              provider: 'zendesk',
              displayName: 'Zendesk prod',
              status: 'active',
              latestObservedAt: '2026-10-02T00:00:00.000Z',
              freshness: 'current',
            },
          ],
          latestObservedAt: '2026-10-02T00:00:00.000Z',
          observationCount: 3,
          explanation: '1 active source(s) but only 3 observation(s) in the window',
        },
      ],
    );
    expect(answer).not.toBeNull();
    expect(answer!.surfaces).toEqual(['support-tickets']);
    expect(answer!.text).toContain('support tickets is partial');
    expect(answer!.text).toContain('Zendesk prod');
    expect(answer!.text).toContain('3 observation(s)');
    expect(answer!.text).toContain('never claims universal capture');
    // The anti-configuration rule stays in the wording.
    expect(answer!.text).not.toMatch(/all|every/);
  });

  it('returns null for non-coverage questions', () => {
    expect(answerCoverageQuestion('What is our revenue?', [])).toBeNull();
  });
});
