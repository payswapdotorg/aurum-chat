// Unit tests for the learning module's W053 pure validation/normalization
// logic and the deterministic learned-prior scoring (no database). Covers
// every guard a caller crosses before storage, plus the single definition
// of how the CompanyModel reorders policy-vetted candidates:
//
//  * CompanyModel vocabularies — the ten ADR-0016 areas, the subject kinds,
//    dispositions, provenance kinds, statuses, rank domains;
//  * subject-key derivation — uuid subjects, slugified names, company-wide,
//    and every illegal combination (both, neither, bad uuid, empty slug);
//  * recordLearningUpdate input validation — change count bounds, duplicate
//    chains within one update, required rationale, traceable actor, area /
//    topic / statement / confidence / disposition / validity-interval
//    guards, provenance (evidence refs and/or outcome link — never none),
//    and unknown-key rejection including the system-minted fields;
//  * CompanyModel query validation — areas filter, includeInactive,
//    assertion list filters (incl. the derived status vocabulary), the
//    learning-updates feed;
//  * rankCandidates input validation — domain, candidate keys (unique,
//    derived), base scores, policy kind lists;
//  * scoreCandidateSet — the deterministic core: base-order passthrough
//    without priors, confidence-weighted blending, uninterpretable
//    statements ignored, superseded/retracted/expired/pending assertions
//    excluded, policy exclusion that learned scores can never rescue, policy
//    kind precedence as a hard sort key, tie-breaking by input position,
//    6-decimal score rounding, and full determinism.
//
// The service-level behaviors (version minting, chain supersession, tenant
// isolation, storage guarantees, the longitudinal fixture) are covered by
// the service and longitudinal tests.

import { describe, expect, it } from 'vitest';
import { LearningError } from '../errors';
import type { AssertionDeltaInput, RankCandidatesInput, RecordLearningUpdateInput } from '../types';
import {
  ASSERTION_PROVENANCE_KINDS,
  CANDIDATE_DOMAINS,
  COMPANY_MODEL_AREAS,
  COMPANY_MODEL_SUBJECT_KINDS,
  DEFAULT_CANDIDATE_BASE_SCORE,
  RANK_DOMAIN_FAMILIES,
  deriveSubjectKey,
  isAssertionDisposition,
  isAssertionProvenanceKind,
  isCandidateDomain,
  isCompanyModelArea,
  isCompanyModelStatus,
  isCompanyModelSubjectKind,
  scoreCandidateSet,
  slugifySubjectName,
  validateGetCompanyModelQuery,
  validateListCompanyAssertionsQuery,
  validateListLearningUpdatesQuery,
  validateRankCandidatesInput,
  validateRecordLearningUpdateInput,
  type ScoreableAssertion,
} from '../validation';

const PERSON_ID = '0b2f8e2a-1c4b-4d8a-9f3e-7a2b6c5d4e8f';
const SOURCE_ID = 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f';
const SOURCE_ID_2 = 'd2e3f4a5-b6c7-4d8e-9f0a-1b2c3d4e5f6a';
const OUTCOME_ID = '9b1c7d5f-0e3a-4f6b-9a4d-5c7e9f1a3b5c';
const OBSERVATION_ID = 'ac2d8e6a-1f4b-4a7c-8b5e-6d8f0a2c4e6d';
const AGENT_ID = '3c5e1a7f-4b6d-4c8e-9d0a-1e3f5a7c9e1b';

const NOW = '2026-09-14T12:00:00.000Z';

function expectCode(code: string, fn: () => unknown): void {
  try {
    fn();
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(LearningError);
    expect((error as LearningError).code).toBe(code);
  }
}

/** A full learning-update delta, parameterized for the suites below. */
function delta(overrides: Partial<AssertionDeltaInput> = {}): AssertionDeltaInput {
  return {
    area: 'source_reliability',
    subject: { kind: 'source', id: SOURCE_ID, label: 'CRM' },
    topic: 'reliability',
    statement: { score: 0.85, note: 'answers were correct in 17 of 20 queries' },
    confidence: 0.8,
    disposition: 'asserted',
    validFrom: null,
    validUntil: null,
    evidence: [{ kind: 'observation', id: OBSERVATION_ID, label: 'crm answer audit' }],
    outcomeId: null,
    ...overrides,
  };
}

/** A full learning-update input, parameterized for the suites below. */
function updateInput(
  overrides: Partial<RecordLearningUpdateInput> = {},
  deltaOverrides: Partial<AssertionDeltaInput> = {},
): RecordLearningUpdateInput {
  return {
    changes: [delta(deltaOverrides)],
    rationale: 'mission cycle 3: CRM answers audited correct',
    actor: { kind: 'person', id: PERSON_ID },
    ...overrides,
  };
}

/** A minimal scoreable assertion (a current chain head), parameterized. */
function scoreable(overrides: Partial<ScoreableAssertion> = {}): ScoreableAssertion {
  return {
    id: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
    area: 'source_reliability',
    subjectKey: `source:${SOURCE_ID}`,
    topic: 'reliability',
    statement: { score: 0.9 },
    confidence: 0.8,
    disposition: 'asserted',
    validFrom: '2026-01-01T00:00:00.000Z',
    validUntil: null,
    version: 1,
    ...overrides,
  };
}

/** A validated rank input, parameterized. */
function rankInput(overrides: Partial<RankCandidatesInput> = {}): RankCandidatesInput {
  return {
    domain: 'source_selection',
    candidates: [
      { kind: 'source', id: SOURCE_ID, label: 'CRM' },
      { kind: 'source', id: SOURCE_ID_2, label: 'Wiki' },
    ],
    policy: { allowedKinds: ['source'], kindPrecedence: ['source'] },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Vocabularies
// ---------------------------------------------------------------------------

describe('CompanyModel vocabularies', () => {
  it('guards the ten ADR-0016 areas and rejects everything else', () => {
    expect(COMPANY_MODEL_AREAS).toHaveLength(10);
    for (const area of COMPANY_MODEL_AREAS) expect(isCompanyModelArea(area)).toBe(true);
    expect(isCompanyModelArea('vocabulary')).toBe(true);
    expect(isCompanyModelArea('intervention_prior')).toBe(true);
    expect(isCompanyModelArea('organizational_norm')).toBe(true);
    expect(isCompanyModelArea('memes')).toBe(false);
    expect(isCompanyModelArea(null)).toBe(false);
  });

  it('guards the subject kinds, dispositions, provenance kinds, statuses and domains', () => {
    for (const kind of COMPANY_MODEL_SUBJECT_KINDS) expect(isCompanyModelSubjectKind(kind)).toBe(true);
    expect(isCompanyModelSubjectKind('supplier')).toBe(false);
    expect(isAssertionDisposition('asserted')).toBe(true);
    expect(isAssertionDisposition('deleted')).toBe(false);
    for (const kind of ASSERTION_PROVENANCE_KINDS) expect(isAssertionProvenanceKind(kind)).toBe(true);
    expect(isAssertionProvenanceKind('guess')).toBe(false);
    expect(isCompanyModelStatus('active')).toBe(true);
    expect(isCompanyModelStatus('live')).toBe(false);
    for (const domain of CANDIDATE_DOMAINS) expect(isCandidateDomain(domain)).toBe(true);
    expect(isCandidateDomain('vendor_selection')).toBe(false);
  });

  it('binds each rank domain to its canonical assertion family', () => {
    expect(RANK_DOMAIN_FAMILIES.source_selection).toEqual({
      area: 'source_reliability',
      topic: 'reliability',
      scoreField: 'score',
    });
    expect(RANK_DOMAIN_FAMILIES.intervention).toEqual({
      area: 'intervention_prior',
      topic: 'effectiveness',
      scoreField: 'score',
    });
  });
});

// ---------------------------------------------------------------------------
// Subject keys
// ---------------------------------------------------------------------------

describe('subject key derivation', () => {
  const err = (message: string): LearningError => new LearningError('invalid_update_input', message);

  it('keys uuid subjects by kind + lowercased uuid', () => {
    expect(deriveSubjectKey('source', SOURCE_ID.toUpperCase(), null, err)).toBe(`source:${SOURCE_ID}`);
    expect(deriveSubjectKey('employee', PERSON_ID, null, err)).toBe(`employee:${PERSON_ID}`);
    expect(deriveSubjectKey('agent', AGENT_ID, null, err)).toBe(`agent:${AGENT_ID}`);
  });

  it('keys name subjects by kind + slug', () => {
    expect(slugifySubjectName('  Churn   Rate! ')).toBe('churn-rate');
    expect(slugifySubjectName('ARR')).toBe('arr');
    expect(slugifySubjectName('café—rítmus')).toBe('caf-r-tmus');
    expect(deriveSubjectKey('term', null, 'Churn Rate', err)).toBe('term:churn-rate');
    expect(deriveSubjectKey('intervention', null, '  Dunning Escalation ', err)).toBe(
      'intervention:dunning-escalation',
    );
  });

  it('keys company-wide subjects as exactly "company"', () => {
    expect(deriveSubjectKey('company', null, null, err)).toBe('company');
    expectCode('invalid_update_input', () => deriveSubjectKey('company', SOURCE_ID, null, err));
    expectCode('invalid_update_input', () => deriveSubjectKey('company', null, 'Acme', err));
  });

  it('rejects every illegal combination', () => {
    expectCode('invalid_update_input', () => deriveSubjectKey('source', SOURCE_ID, 'CRM', err)); // both
    expectCode('invalid_update_input', () => deriveSubjectKey('source', null, null, err)); // neither
    expectCode('invalid_update_input', () => deriveSubjectKey('source', 'not-a-uuid', null, err)); // bad uuid
    expectCode('invalid_update_input', () => deriveSubjectKey('term', null, '!!!', err)); // empty slug
    expectCode('invalid_update_input', () =>
      deriveSubjectKey('term', null, 'a'.repeat(121), err), // name too long
    );
  });
});

// ---------------------------------------------------------------------------
// validateRecordLearningUpdateInput
// ---------------------------------------------------------------------------

describe('validateRecordLearningUpdateInput', () => {
  it('normalizes a full update and round-trips every field', () => {
    const valid = validateRecordLearningUpdateInput(updateInput());
    expect(valid.rationale).toBe('mission cycle 3: CRM answers audited correct');
    expect(valid.actor).toEqual({ kind: 'person', id: PERSON_ID, label: null });
    expect(valid.changes).toHaveLength(1);
    const change = valid.changes[0]!;
    expect(change.area).toBe('source_reliability');
    expect(change.subject).toEqual({ kind: 'source', key: `source:${SOURCE_ID}`, label: 'CRM' });
    expect(change.topic).toBe('reliability');
    expect(change.statement).toEqual({ score: 0.85, note: 'answers were correct in 17 of 20 queries' });
    expect(change.confidence).toBe(0.8);
    expect(change.disposition).toBe('asserted');
    expect(change.validFrom).toBeNull();
    expect(change.validUntil).toBeNull();
    expect(change.evidence).toEqual([{ kind: 'observation', id: OBSERVATION_ID, label: 'crm answer audit' }]);
    expect(change.outcomeId).toBeNull();
  });

  it('applies defaults: asserted disposition, no validity bounds, no outcome link', () => {
    const valid = validateRecordLearningUpdateInput({
      changes: [
        {
          area: 'vocabulary',
          subject: { kind: 'term', name: 'ARR' },
          topic: 'definition',
          statement: { definition: 'annualized run-rate revenue' },
          confidence: 0.6,
          evidence: [{ kind: 'document', label: 'finance glossary' }],
        },
      ],
      rationale: 'learned the finance team vocabulary',
      actor: { kind: 'system', label: 'cognition' },
    });
    const change = valid.changes[0]!;
    expect(change.disposition).toBe('asserted');
    expect(change.validFrom).toBeNull();
    expect(change.validUntil).toBeNull();
    expect(change.outcomeId).toBeNull();
    expect(change.subject.key).toBe('term:arr');
  });

  it('accepts every ADR-0016 area and both dispositions', () => {
    for (const area of COMPANY_MODEL_AREAS) {
      const valid = validateRecordLearningUpdateInput(updateInput({}, { area }));
      expect(valid.changes[0]!.area).toBe(area);
    }
    const retracted = validateRecordLearningUpdateInput(
      updateInput({}, { disposition: 'retracted', statement: {} }),
    );
    expect(retracted.changes[0]!.disposition).toBe('retracted');
  });

  it('bounds the change-set size and rejects duplicate chains within one update', () => {
    const sixteen = Array.from({ length: 16 }, (_, index) =>
      delta({ subject: { kind: 'source', id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}` } }),
    );
    expect(validateRecordLearningUpdateInput(updateInput({ changes: sixteen })).changes).toHaveLength(16);

    expectCode('invalid_update_input', () => validateRecordLearningUpdateInput(updateInput({ changes: [] })));
    expectCode('invalid_update_input', () =>
      validateRecordLearningUpdateInput(updateInput({ changes: [...sixteen, delta()] })),
    );
    expectCode('invalid_update_input', () =>
      validateRecordLearningUpdateInput(updateInput({ changes: [delta(), delta()] })),
    );
    // different topics of the same subject are different chains — legal
    expect(() =>
      validateRecordLearningUpdateInput(updateInput({ changes: [delta(), delta({ topic: 'freshness' })] })),
    ).not.toThrow();
  });

  it('requires a bounded non-empty rationale and a traceable actor', () => {
    expectCode('invalid_update_input', () => validateRecordLearningUpdateInput(updateInput({ rationale: '  ' })));
    expectCode('invalid_update_input', () =>
      validateRecordLearningUpdateInput(updateInput({ rationale: 'a'.repeat(2001) })),
    );
    expectCode('invalid_update_input', () =>
      validateRecordLearningUpdateInput(updateInput({ actor: { kind: 'person', id: null, label: null } })),
    );
  });

  it('validates the statement payload: object, key count, key length, serialized size', () => {
    expectCode('invalid_update_input', () =>
      validateRecordLearningUpdateInput(updateInput({}, { statement: 'reliable' as never })),
    );
    expectCode('invalid_update_input', () =>
      validateRecordLearningUpdateInput(updateInput({}, { statement: [1, 2] as never })),
    );
    const tooManyKeys = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, i]));
    expectCode('invalid_update_input', () =>
      validateRecordLearningUpdateInput(updateInput({}, { statement: tooManyKeys })),
    );
    expectCode('invalid_update_input', () =>
      validateRecordLearningUpdateInput(
        updateInput({}, { statement: { ['k'.repeat(65)]: 1 } }),
      ),
    );
    expectCode('invalid_update_input', () =>
      validateRecordLearningUpdateInput(
        updateInput({}, { statement: { blob: 'x'.repeat(4097) } }),
      ),
    );
    // the empty object is a legal (retraction-style) payload
    expect(validateRecordLearningUpdateInput(updateInput({}, { statement: {} })).changes[0]!.statement).toEqual(
      {},
    );
  });

  it('bounds confidence to [0, 1] and rejects non-finite values', () => {
    expect(validateRecordLearningUpdateInput(updateInput({}, { confidence: 0 })).changes[0]!.confidence).toBe(0);
    expect(validateRecordLearningUpdateInput(updateInput({}, { confidence: 1 })).changes[0]!.confidence).toBe(1);
    expectCode('invalid_update_input', () => validateRecordLearningUpdateInput(updateInput({}, { confidence: 1.01 })));
    expectCode('invalid_update_input', () => validateRecordLearningUpdateInput(updateInput({}, { confidence: -0.1 })));
    expectCode('invalid_update_input', () =>
      validateRecordLearningUpdateInput(updateInput({}, { confidence: Number.NaN })),
    );
  });

  it('validates the validity interval: ISO 8601, real instants, strictly increasing', () => {
    expectCode('invalid_update_input', () =>
      validateRecordLearningUpdateInput(updateInput({}, { validFrom: 'yesterday' })),
    );
    expectCode('invalid_update_input', () =>
      validateRecordLearningUpdateInput(updateInput({}, { validFrom: '2026-02-30' })),
    );
    expectCode('invalid_update_input', () =>
      validateRecordLearningUpdateInput(
        updateInput({}, { validFrom: '2026-01-01T00:00:00Z', validUntil: '2026-01-01T00:00:00Z' }),
      ),
    );
    expectCode('invalid_update_input', () =>
      validateRecordLearningUpdateInput(
        updateInput({}, { validFrom: '2026-06-01', validUntil: '2026-01-01' }),
      ),
    );
    const valid = validateRecordLearningUpdateInput(
      updateInput({}, { validFrom: '2026-01-01', validUntil: '2027-01-01T00:00:00+02:00' }),
    );
    expect(valid.changes[0]!.validFrom).toBe('2026-01-01');
    expect(valid.changes[0]!.validUntil).toBe('2027-01-01T00:00:00+02:00');
  });

  it('requires provenance: evidence references and/or an outcome link — never none', () => {
    expectCode('invalid_update_input', () =>
      validateRecordLearningUpdateInput(updateInput({}, { evidence: [], outcomeId: null })),
    );
    // evidence alone is enough
    expect(() => validateRecordLearningUpdateInput(updateInput())).not.toThrow();
    // an outcome link alone is enough
    expect(() => validateRecordLearningUpdateInput(updateInput({}, { evidence: [], outcomeId: OUTCOME_ID }))).not.toThrow();
  });

  it('validates provenance references: known kinds, uuid-or-label, capped', () => {
    expectCode('invalid_update_input', () =>
      validateRecordLearningUpdateInput(updateInput({}, { evidence: [{ kind: 'hunch', label: 'x' } as never] })),
    );
    expectCode('invalid_update_input', () =>
      validateRecordLearningUpdateInput(updateInput({}, { evidence: [{ kind: 'observation', id: 'no' } as never] })),
    );
    expectCode('invalid_update_input', () =>
      validateRecordLearningUpdateInput(updateInput({}, { evidence: [{ kind: 'interaction' } as never] })),
    );
    const nine = Array.from({ length: 9 }, (_, index) => ({
      kind: 'observation' as const,
      label: `ref-${index}`,
    }));
    expectCode('invalid_update_input', () => validateRecordLearningUpdateInput(updateInput({}, { evidence: nine })));
    expectCode('invalid_update_input', () =>
      validateRecordLearningUpdateInput(updateInput({}, { outcomeId: 'not-a-uuid' })),
    );
    const interaction = validateRecordLearningUpdateInput(
      updateInput({}, { evidence: [{ kind: 'interaction', label: 'confirmed with controller' }] }),
    );
    expect(interaction.changes[0]!.evidence).toEqual([
      { kind: 'interaction', id: null, label: 'confirmed with controller' },
    ]);
  });

  it('rejects unknown keys, including every system-minted field', () => {
    for (const systemField of ['id', 'version', 'supersedesId', 'updateId', 'modelVersion', 'recordedAt', 'recordedByPrincipal', 'status'] as const) {
      expectCode(
        'invalid_update_input',
        () => validateRecordLearningUpdateInput(updateInput({}, { [systemField]: 'x' } as never)),
      );
    }
    expectCode('invalid_update_input', () =>
      validateRecordLearningUpdateInput(updateInput({ modelVersion: 7 } as never)),
    );
    expectCode('invalid_update_input', () =>
      validateRecordLearningUpdateInput(updateInput({ changes: [{ ...delta(), subject: { kind: 'source', id: SOURCE_ID, label: 'CRM', bogus: 1 } as never }] })),
    );
  });
});

// ---------------------------------------------------------------------------
// CompanyModel query validation
// ---------------------------------------------------------------------------

describe('CompanyModel query validation', () => {
  it('validates the model view query: unique known areas, boolean includeInactive', () => {
    expect(validateGetCompanyModelQuery({})).toEqual({ areas: null, includeInactive: false });
    expect(validateGetCompanyModelQuery({ areas: ['vocabulary'], includeInactive: true })).toEqual({
      areas: ['vocabulary'],
      includeInactive: true,
    });
    expectCode('invalid_query', () => validateGetCompanyModelQuery({ areas: [] }));
    expectCode('invalid_query', () => validateGetCompanyModelQuery({ areas: ['vocabulary', 'vocabulary'] }));
    expectCode('invalid_query', () => validateGetCompanyModelQuery({ areas: ['gossip'] }));
    expectCode('invalid_query', () => validateGetCompanyModelQuery({ includeInactive: 'yes' }));
  });

  it('validates the assertion list query filters', () => {
    expect(validateListCompanyAssertionsQuery({})).toEqual({
      area: null,
      subjectKind: null,
      subjectKey: null,
      topic: null,
      status: null,
      outcomeId: null,
      updateId: null,
      search: null,
      limit: 50,
    });
    expect(
      validateListCompanyAssertionsQuery({
        area: 'source_reliability',
        subjectKind: 'source',
        subjectKey: `source:${SOURCE_ID}`,
        topic: 'reliability',
        status: 'superseded',
        outcomeId: OUTCOME_ID,
        search: 'crm',
        limit: 500,
      }).limit,
    ).toBe(500);
    expectCode('invalid_query', () => validateListCompanyAssertionsQuery({ status: 'zombie' }));
    expectCode('invalid_query', () => validateListCompanyAssertionsQuery({ area: 'gossip' }));
    expectCode('invalid_query', () => validateListCompanyAssertionsQuery({ outcomeId: 'no' }));
    expectCode('invalid_query', () => validateListCompanyAssertionsQuery({ limit: 0 }));
    expectCode('invalid_query', () => validateListCompanyAssertionsQuery({ limit: 501 }));
  });

  it('validates the learning-updates feed query', () => {
    expect(validateListLearningUpdatesQuery({})).toEqual({ search: null, limit: 50 });
    expect(validateListLearningUpdatesQuery({ search: 'churn', limit: 1 })).toEqual({
      search: 'churn',
      limit: 1,
    });
    expectCode('invalid_query', () => validateListLearningUpdatesQuery({ search: 'x'.repeat(201) }));
    expectCode('invalid_query', () => validateListLearningUpdatesQuery({ limit: -1 }));
  });
});

// ---------------------------------------------------------------------------
// validateRankCandidatesInput
// ---------------------------------------------------------------------------

describe('validateRankCandidatesInput', () => {
  it('validates a full rank request and derives candidate keys', () => {
    const valid = validateRankCandidatesInput(rankInput());
    expect(valid.domain).toBe('source_selection');
    expect(valid.candidates).toEqual([
      { kind: 'source', key: `source:${SOURCE_ID}`, label: 'CRM', baseScore: DEFAULT_CANDIDATE_BASE_SCORE },
      { kind: 'source', key: `source:${SOURCE_ID_2}`, label: 'Wiki', baseScore: DEFAULT_CANDIDATE_BASE_SCORE },
    ]);
    expect(valid.policy).toEqual({ allowedKinds: ['source'], kindPrecedence: ['source'] });
  });

  it('rejects unknown domains, empty/oversized candidate sets and duplicates', () => {
    expectCode('invalid_rank_input', () => validateRankCandidatesInput(rankInput({ domain: 'vendor' as never })));
    expectCode('invalid_rank_input', () => validateRankCandidatesInput(rankInput({ candidates: [] })));
    const dup = [
      { kind: 'term' as const, name: 'ARR' },
      { kind: 'term' as const, name: 'arr' },
    ];
    expectCode('invalid_rank_input', () => validateRankCandidatesInput(rankInput({ candidates: dup })));
    const many = Array.from({ length: 33 }, (_, index) => ({
      kind: 'source' as const,
      id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    }));
    expectCode('invalid_rank_input', () => validateRankCandidatesInput(rankInput({ candidates: many })));
  });

  it('bounds base scores and validates policy kind lists', () => {
    expect(validateRankCandidatesInput(rankInput({ candidates: [{ kind: 'source', id: SOURCE_ID, baseScore: 1 }] })).candidates[0]!.baseScore).toBe(1);
    expectCode('invalid_rank_input', () =>
      validateRankCandidatesInput(rankInput({ candidates: [{ kind: 'source', id: SOURCE_ID, baseScore: 1.5 }] })),
    );
    expectCode('invalid_rank_input', () =>
      validateRankCandidatesInput(rankInput({ policy: { allowedKinds: ['source', 'source'] } })),
    );
    expectCode('invalid_rank_input', () =>
      validateRankCandidatesInput(rankInput({ policy: { kindPrecedence: [] } })),
    );
    expectCode('invalid_rank_input', () =>
      validateRankCandidatesInput(rankInput({ policy: { allowedKinds: ['x'.repeat(41)] } })),
    );
    // a policy of null/undefined means "no constraints supplied"
    expect(validateRankCandidatesInput({ domain: 'source_selection', candidates: [{ kind: 'source', id: SOURCE_ID }] }).policy).toEqual(
      { allowedKinds: null, kindPrecedence: null },
    );
  });
});

// ---------------------------------------------------------------------------
// scoreCandidateSet — the deterministic core
// ---------------------------------------------------------------------------

describe('scoreCandidateSet', () => {
  const crm = { kind: 'source' as const, id: SOURCE_ID, label: 'CRM' };
  const wiki = { kind: 'source' as const, id: SOURCE_ID_2, label: 'Wiki' };
  const external = { kind: 'term' as const, name: 'market-feed', label: 'Market feed' };

  it('passes the base order through when no priors apply', () => {
    const input = validateRankCandidatesInput({ domain: 'source_selection', candidates: [crm, wiki, external] });
    const scored = scoreCandidateSet([], input, NOW);
    expect(scored.map((candidate) => candidate.key)).toEqual([
      `source:${SOURCE_ID}`,
      `source:${SOURCE_ID_2}`,
      'term:market-feed',
    ]);
    for (const candidate of scored) {
      expect(candidate.score).toBe(DEFAULT_CANDIDATE_BASE_SCORE);
      expect(candidate.learnedScore).toBeNull();
      expect(candidate.appliedPrior).toBeNull();
      expect(candidate.policyExcluded).toBe(false);
      expect(candidate.policyTier).toBe(0);
    }
  });

  it('blends the learned prior into the base score by confidence (exact math)', () => {
    const input = validateRankCandidatesInput({
      domain: 'source_selection',
      candidates: [crm, { ...wiki, baseScore: 0.2 }],
    });
    const scored = scoreCandidateSet(
      [scoreable({ subjectKey: `source:${SOURCE_ID}`, statement: { score: 0.9 }, confidence: 0.8 })],
      input,
      NOW,
    );
    // CRM: 0.5·(1−0.8) + 0.9·0.8 = 0.82
    expect(scored[0]!.key).toBe(`source:${SOURCE_ID}`);
    expect(scored[0]!.score).toBe(0.82);
    expect(scored[0]!.learnedScore).toBe(0.9);
    expect(scored[0]!.appliedPrior).toEqual({
      assertionId: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
      version: 1,
      confidence: 0.8,
      learnedScore: 0.9,
    });
    // Wiki keeps its base score: 0.2
    expect(scored[1]!.score).toBe(0.2);
    expect(scored[1]!.learnedScore).toBeNull();
  });

  it('ignores assertions whose statement carries no interpretable [0,1] score', () => {
    const input = validateRankCandidatesInput({ domain: 'source_selection', candidates: [crm] });
    for (const statement of [{ note: 'no score' }, { score: 1.5 }, { score: -0.2 }, { score: 'high' }]) {
      const scored = scoreCandidateSet([scoreable({ statement })], input, NOW);
      expect(scored[0]!.learnedScore).toBeNull();
      expect(scored[0]!.score).toBe(DEFAULT_CANDIDATE_BASE_SCORE);
    }
  });

  it('uses only the highest-version current assertion and excludes inactive ones', () => {
    const input = validateRankCandidatesInput({ domain: 'source_selection', candidates: [crm] });
    const scored = scoreCandidateSet(
      [
        scoreable({ id: 'v1-00000000-0000-4000-8000-000000000001', version: 1, statement: { score: 0.1 } }),
        scoreable({ id: 'v2-00000000-0000-4000-8000-000000000002', version: 2, statement: { score: 0.95 }, confidence: 1 }),
        scoreable({ id: 'v3-00000000-0000-4000-8000-000000000003', version: 3, disposition: 'retracted' }),
      ],
      input,
      NOW,
    );
    expect(scored[0]!.appliedPrior!.version).toBe(2);
    expect(scored[0]!.score).toBe(0.95);

    // pending / expired assertions never apply
    const pending = scoreable({ validFrom: '2027-01-01T00:00:00.000Z' });
    expect(scoreCandidateSet([pending], input, NOW)[0]!.learnedScore).toBeNull();
    const expired = scoreable({ validUntil: '2026-06-01T00:00:00.000Z' });
    expect(scoreCandidateSet([expired], input, NOW)[0]!.learnedScore).toBeNull();
    const active = scoreable({ validFrom: '2026-06-01T00:00:00.000Z', validUntil: '2027-01-01T00:00:00.000Z' });
    expect(scoreCandidateSet([active], input, NOW)[0]!.learnedScore).toBe(0.9);
  });

  it('applies only the domain family — other areas/topics never influence the score', () => {
    const input = validateRankCandidatesInput({ domain: 'source_selection', candidates: [crm] });
    const offFamily = scoreable({
      area: 'intervention_prior',
      topic: 'effectiveness',
      statement: { score: 0.99 },
      confidence: 1,
    });
    const offTopic = scoreable({ topic: 'freshness', statement: { score: 0.99 }, confidence: 1 });
    expect(scoreCandidateSet([offFamily, offTopic], input, NOW)[0]!.learnedScore).toBeNull();

    const interventionInput = validateRankCandidatesInput({
      domain: 'intervention',
      candidates: [{ kind: 'intervention', name: 'dunning-escalation' }],
    });
    const prior = scoreCandidateSet(
      [scoreable({ area: 'intervention_prior', topic: 'effectiveness', subjectKey: 'intervention:dunning-escalation' })],
      interventionInput,
      NOW,
    );
    expect(prior[0]!.learnedScore).toBe(0.9);
  });

  it('never lets a learned score rescue a policy-excluded kind', () => {
    const input = validateRankCandidatesInput({
      domain: 'source_selection',
      candidates: [crm, { ...external, baseScore: 0.1 }],
      policy: { allowedKinds: ['source'] },
    });
    const scored = scoreCandidateSet(
      [scoreable({ subjectKey: 'term:market-feed', statement: { score: 0.99 }, confidence: 1 })],
      input,
      NOW,
    );
    // the excluded external candidate learned to be excellent — and still sinks
    expect(scored[0]!.key).toBe(`source:${SOURCE_ID}`);
    expect(scored[1]!.key).toBe('term:market-feed');
    expect(scored[1]!.policyExcluded).toBe(true);
    expect(scored[1]!.appliedPrior).not.toBeNull(); // the prior applied…
    expect(scored[1]!.score).toBe(0.99); // …and the score is high…
    // …but policy beats it: excluded candidates always sort last
  });

  it('treats policy kind precedence as a hard sort key ahead of every learned score', () => {
    const input = validateRankCandidatesInput({
      domain: 'source_selection',
      candidates: [external, crm],
      policy: { kindPrecedence: ['term', 'source'] },
    });
    const scored = scoreCandidateSet(
      [scoreable({ subjectKey: `source:${SOURCE_ID}`, statement: { score: 0.99 }, confidence: 1 })],
      input,
      NOW,
    );
    // CRM learned a near-perfect 0.99; policy still puts terms first
    expect(scored[0]!.key).toBe('term:market-feed');
    expect(scored[0]!.policyTier).toBe(0);
    expect(scored[1]!.key).toBe(`source:${SOURCE_ID}`);
    expect(scored[1]!.policyTier).toBe(1);
    expect(scored[1]!.score).toBe(0.99);
  });

  it('ranks kinds missing from the precedence list in the lowest tier, stably', () => {
    const input = validateRankCandidatesInput({
      domain: 'source_selection',
      candidates: [crm, external, wiki],
      policy: { kindPrecedence: ['source'] },
    });
    const scored = scoreCandidateSet([], input, NOW);
    expect(scored.map((candidate) => candidate.key)).toEqual([
      `source:${SOURCE_ID}`,
      `source:${SOURCE_ID_2}`,
      'term:market-feed',
    ]);
    expect(scored[2]!.policyTier).toBe(1);
  });

  it('breaks score ties by input position and rounds scores to 6 decimals', () => {
    const input = validateRankCandidatesInput({
      domain: 'source_selection',
      candidates: [crm, wiki],
    });
    const scored = scoreCandidateSet(
      [
        scoreable({ subjectKey: `source:${SOURCE_ID}`, statement: { score: 1 / 3 }, confidence: 1 / 3 }),
        scoreable({ subjectKey: `source:${SOURCE_ID_2}`, statement: { score: 1 / 3 }, confidence: 1 / 3 }),
      ],
      input,
      NOW,
    );
    // identical arithmetic → identical rounded score → input order preserved
    expect(scored[0]!.score).toBe(scored[1]!.score);
    expect(scored[0]!.key).toBe(`source:${SOURCE_ID}`);
    expect(scored[1]!.key).toBe(`source:${SOURCE_ID_2}`);
    expect(scored[0]!.score.toString()).toMatch(/^\d+(\.\d{1,6})?$/);
  });

  it('is a pure deterministic function — same inputs, same output', () => {
    const input = validateRankCandidatesInput({
      domain: 'source_selection',
      candidates: [crm, wiki, external],
      policy: { allowedKinds: ['source', 'term'], kindPrecedence: ['source', 'term'] },
    });
    const assertions = [
      scoreable({ subjectKey: `source:${SOURCE_ID}`, statement: { score: 0.8 }, confidence: 0.9 }),
      scoreable({ subjectKey: 'term:market-feed', statement: { score: 0.4 }, confidence: 0.3 }),
    ];
    const first = scoreCandidateSet(assertions, input, NOW);
    const second = scoreCandidateSet([...assertions], input, NOW);
    expect(first).toEqual(second);
  });
});
