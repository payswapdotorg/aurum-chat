// Unit tests for the learning module's W041 pure validation/normalization
// logic (no database): every guard a caller crosses before a company
// learning version is stored.
//
//  * tenant-context shape (invalid_context) — shared with W040's suite;
//  * record-input validation — the learning target (the eight W041 target
//    kinds, REQUIRED uuid id — the tie must be precise, optional bounded
//    label), the aspect slug (lowercase, dots/dashes/underscores, ≤100),
//    the learned value (non-null plain JSON, deep-checked, bounded bytes),
//    confidence (finite, 0..1), the feedback channel vocabulary, the
//    REQUIRED reason (ADR-0016's learning invariant: a learning update
//    must identify what changed and why), evidence refs, and the channel
//    shapes: behavioral feedback MUST cite evidence, outcome feedback
//    REQUIRES outcomeId, other channels must NOT carry one;
//  * validity window: optional real-calendar ISO date;
//  * unknown-key rejection including the system-minted fields — and above
//    all `authoritative`: a learned assertion is never authoritative
//    (lock 14, ADR-0016), so a caller cannot even express a policy claim;
//  * list/versions query validation — targetId requires targetKind,
//    bounded limit, uuid learningId;
//  * deriveLearningStatus — the single deterministic definition of a
//    chain's read-time validity (active while valid_until is null or not
//    elapsed; expired afterwards; a date holds through the end of its day).

import { describe, expect, it } from 'vitest';
import { LearningError } from '../errors';
import type { RecordCompanyLearningInput } from '../types';
import {
  LEARNING_FEEDBACK_CHANNELS,
  LEARNING_STATUSES,
  LEARNING_TARGET_KINDS,
  MAX_ASPECT_LENGTH,
  MAX_LEARNING_VALUE_BYTES,
  deriveLearningStatus,
  isLearningFeedbackChannel,
  isLearningStatus,
  isLearningTargetKind,
  validateListCompanyLearningsQuery,
  validateListCompanyLearningVersionsQuery,
  validateRecordCompanyLearningInput,
} from '../validation';

const PERSON_ID = '0b2f8e2a-1c4b-4d8a-9f3e-7a2b6c5d4e8f';
const SOURCE_ID = '1e3f5a7c-9b2d-4c6e-8d0a-2f4a6b8c0d2e';
const OUTCOME_ID = '9b1c7d5f-0e3a-4f6b-9a4d-5c7e9f1a3b5c';
const OBSERVATION_ID = 'ac2d8e6a-1f4b-4a7c-8b5e-6d8f0a2c4e6d';

/** A full W041 feedback record, parameterized for the suites below. */
function learningInput(overrides: Partial<RecordCompanyLearningInput> = {}): RecordCompanyLearningInput {
  return {
    target: { kind: 'source', id: SOURCE_ID, label: 'CRM export' },
    aspect: 'source-reliability',
    value: { usefulness: 0.8, note: 'fast and complete' },
    confidence: 0.7,
    channel: 'explicit',
    reason: 'ops lead stated CRM exports answered every churn question',
    evidence: [{ kind: 'observation', id: OBSERVATION_ID, label: 'churn export' }],
    outcomeId: null,
    validUntil: null,
    actor: { kind: 'person', id: PERSON_ID },
    ...overrides,
  };
}

function expectCode(code: string, fn: () => unknown): void {
  try {
    fn();
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(LearningError);
    expect((error as LearningError).code).toBe(code);
  }
}

// ---------------------------------------------------------------------------
// Vocabularies and type guards
// ---------------------------------------------------------------------------

describe('W041 vocabularies', () => {
  it('enumerates the three feedback channels and the two validity states', () => {
    expect(LEARNING_FEEDBACK_CHANNELS).toEqual(['explicit', 'behavioral', 'outcome']);
    expect(LEARNING_STATUSES).toEqual(['active', 'expired']);
  });

  it('enumerates the eight target kinds of company learning', () => {
    expect(LEARNING_TARGET_KINDS).toEqual([
      'source',
      'person',
      'agent',
      'extension',
      'mission',
      'channel',
      'process',
      'capability',
    ]);
    expect(LEARNING_TARGET_KINDS).toHaveLength(8);
  });

  it('guards the vocabularies', () => {
    for (const kind of LEARNING_TARGET_KINDS) expect(isLearningTargetKind(kind)).toBe(true);
    expect(isLearningTargetKind('topic')).toBe(false);
    expect(isLearningTargetKind('vendor')).toBe(false);
    for (const channel of LEARNING_FEEDBACK_CHANNELS) expect(isLearningFeedbackChannel(channel)).toBe(true);
    expect(isLearningFeedbackChannel('implicit')).toBe(false);
    for (const status of LEARNING_STATUSES) expect(isLearningStatus(status)).toBe(true);
    expect(isLearningStatus('terminal')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// recordCompanyLearning input validation
// ---------------------------------------------------------------------------

describe('validateRecordCompanyLearningInput', () => {
  it('normalizes and round-trips a full explicit feedback record', () => {
    const valid = validateRecordCompanyLearningInput(learningInput());
    expect(valid.target).toEqual({ kind: 'source', id: SOURCE_ID, label: 'CRM export' });
    expect(valid.aspect).toBe('source-reliability');
    expect(valid.value).toEqual({ usefulness: 0.8, note: 'fast and complete' });
    expect(valid.confidence).toBe(0.7);
    expect(valid.channel).toBe('explicit');
    expect(valid.reason).toBe('ops lead stated CRM exports answered every churn question');
    expect(valid.evidence).toEqual([{ kind: 'observation', id: OBSERVATION_ID, label: 'churn export' }]);
    expect(valid.outcomeId).toBeNull();
    expect(valid.validUntil).toBeNull();
    expect(valid.actor).toEqual({ kind: 'person', id: PERSON_ID, label: null });
  });

  it('normalizes the aspect to a lowercase slug', () => {
    const valid = validateRecordCompanyLearningInput(
      learningInput({ aspect: '  Source-Reliability  ' }),
    );
    expect(valid.aspect).toBe('source-reliability');
  });

  it('accepts every target kind with a required uuid id', () => {
    for (const kind of LEARNING_TARGET_KINDS) {
      const valid = validateRecordCompanyLearningInput(
        learningInput({ target: { kind, id: SOURCE_ID } }),
      );
      expect(valid.target.kind).toBe(kind);
      expect(valid.target.label).toBeNull();
    }
  });

  it('rejects malformed targets', () => {
    expectCode('invalid_learning_input', () =>
      validateRecordCompanyLearningInput(learningInput({ target: { kind: 'topic', id: SOURCE_ID } as never })),
    );
    expectCode('invalid_learning_input', () =>
      validateRecordCompanyLearningInput(learningInput({ target: { kind: 'source' } as never })),
    );
    expectCode('invalid_learning_input', () =>
      validateRecordCompanyLearningInput(learningInput({ target: { kind: 'source', id: 'not-a-uuid' } })),
    );
    expectCode('invalid_learning_input', () =>
      validateRecordCompanyLearningInput(
        learningInput({ target: { kind: 'source', id: SOURCE_ID, label: 'x'.repeat(201) } }),
      ),
    );
  });

  it('rejects non-slug aspects', () => {
    for (const aspect of ['', '  ', 'has space', '.leading', '-leading', 'a'.repeat(101), 'double..dot?', 'under_score!', 'ümlaut']) {
      expectCode('invalid_learning_input', () => validateRecordCompanyLearningInput(learningInput({ aspect })));
    }
    expect(MAX_ASPECT_LENGTH).toBe(100);
    // a maximal legal slug passes
    expect(() =>
      validateRecordCompanyLearningInput(learningInput({ aspect: 'a'.repeat(100) })),
    ).not.toThrow();
  });

  it('accepts any plain JSON value and rejects non-JSON or oversized values', () => {
    for (const value of [0.8, 42, 'high', true, [1, 'two', null], { a: { b: [true, null] } }]) {
      expect(() => validateRecordCompanyLearningInput(learningInput({ value }))).not.toThrow();
    }
    expectCode('invalid_learning_input', () => validateRecordCompanyLearningInput(learningInput({ value: null })));
    expectCode('invalid_learning_input', () =>
      validateRecordCompanyLearningInput(learningInput({ value: undefined })),
    );
    expectCode('invalid_learning_input', () =>
      validateRecordCompanyLearningInput(learningInput({ value: new Date() })),
    );
    expectCode('invalid_learning_input', () =>
      validateRecordCompanyLearningInput(learningInput({ value: Number.NaN })),
    );
    expectCode('invalid_learning_input', () =>
      validateRecordCompanyLearningInput(learningInput({ value: { nested: Number.POSITIVE_INFINITY } })),
    );
    expectCode('invalid_learning_input', () =>
      validateRecordCompanyLearningInput(learningInput({ value: { fn: () => 1 } })),
    );
    // size cap: a string just over the serialized limit
    expect(MAX_LEARNING_VALUE_BYTES).toBe(16_384);
    expectCode('invalid_learning_input', () =>
      validateRecordCompanyLearningInput(learningInput({ value: 'x'.repeat(MAX_LEARNING_VALUE_BYTES) })),
    );
  });

  it('bounds confidence to finite [0, 1]', () => {
    for (const confidence of [0, 1, 0.5, 0.9999]) {
      expect(() => validateRecordCompanyLearningInput(learningInput({ confidence }))).not.toThrow();
    }
    for (const confidence of [-0.01, 1.01, Number.NaN, Number.POSITIVE_INFINITY, 'high'] as unknown[]) {
      expectCode('invalid_learning_input', () =>
        validateRecordCompanyLearningInput(learningInput({ confidence: confidence as number })),
      );
    }
  });

  it('requires a bounded reason (the learning invariant why)', () => {
    expectCode('invalid_learning_input', () =>
      validateRecordCompanyLearningInput(learningInput({ reason: '' })),
    );
    expectCode('invalid_learning_input', () =>
      validateRecordCompanyLearningInput(learningInput({ reason: 'x'.repeat(2001) })),
    );
  });

  it('rejects unknown channels and malformed evidence', () => {
    expectCode('invalid_learning_input', () =>
      validateRecordCompanyLearningInput(learningInput({ channel: 'implicit' as never })),
    );
    expectCode('invalid_learning_input', () =>
      validateRecordCompanyLearningInput(
        learningInput({ evidence: new Array(9).fill({ kind: 'observation', id: OBSERVATION_ID }) }),
      ),
    );
    expectCode('invalid_learning_input', () =>
      validateRecordCompanyLearningInput(learningInput({ evidence: [{ kind: 'hunch', label: 'nope' } as never] })),
    );
    // an evidence reference must be traceable (id or label)
    expectCode('invalid_learning_input', () =>
      validateRecordCompanyLearningInput(learningInput({ evidence: [{ kind: 'observation' } as never] })),
    );
  });

  it('requires evidence for behavioral feedback', () => {
    expectCode('invalid_learning_input', () =>
      validateRecordCompanyLearningInput(
        learningInput({ channel: 'behavioral', evidence: [] }),
      ),
    );
    // with evidence it is legal
    expect(() =>
      validateRecordCompanyLearningInput(
        learningInput({ channel: 'behavioral', evidence: [{ kind: 'event', id: OBSERVATION_ID }] }),
      ),
    ).not.toThrow();
  });

  it('enforces the outcome channel shape', () => {
    // outcome feedback requires outcomeId
    expectCode('invalid_learning_input', () =>
      validateRecordCompanyLearningInput(
        learningInput({ channel: 'outcome', outcomeId: null }),
      ),
    );
    // non-uuid outcome ids are input errors
    expectCode('invalid_learning_input', () =>
      validateRecordCompanyLearningInput(
        learningInput({ channel: 'outcome', outcomeId: 'not-a-uuid' }),
      ),
    );
    // the other channels must not carry an outcome link
    expectCode('invalid_learning_input', () =>
      validateRecordCompanyLearningInput(learningInput({ channel: 'explicit', outcomeId: OUTCOME_ID })),
    );
    expectCode('invalid_learning_input', () =>
      validateRecordCompanyLearningInput(learningInput({ channel: 'behavioral', outcomeId: OUTCOME_ID })),
    );
    // the legal shape
    expect(() =>
      validateRecordCompanyLearningInput(
        learningInput({ channel: 'outcome', outcomeId: OUTCOME_ID, evidence: [] }),
      ),
    ).not.toThrow();
  });

  it('validates the validity window as a real calendar date', () => {
    expectCode('invalid_learning_input', () =>
      validateRecordCompanyLearningInput(learningInput({ validUntil: '2027-13-01' })),
    );
    expectCode('invalid_learning_input', () =>
      validateRecordCompanyLearningInput(learningInput({ validUntil: '2027-02-30' })),
    );
    expectCode('invalid_learning_input', () =>
      validateRecordCompanyLearningInput(learningInput({ validUntil: 'not-a-date' })),
    );
    expect(() =>
      validateRecordCompanyLearningInput(learningInput({ validUntil: '2027-02-28' })),
    ).not.toThrow();
  });

  it('requires a traceable actor and rejects non-objects', () => {
    expectCode('invalid_learning_input', () =>
      validateRecordCompanyLearningInput(learningInput({ actor: { kind: 'person' } as never })),
    );
    expectCode('invalid_learning_input', () =>
      validateRecordCompanyLearningInput(learningInput({ actor: { kind: 'vendor', id: PERSON_ID } as never })),
    );
    expectCode('invalid_learning_input', () => validateRecordCompanyLearningInput('nope' as never));
  });

  it('rejects unknown keys — the system-minted fields and above all `authoritative`', () => {
    // a learned assertion is never authoritative (lock 14, ADR-0016): the
    // input surface cannot even express a policy claim.
    expectCode('invalid_learning_input', () =>
      validateRecordCompanyLearningInput(
        learningInput({ authoritative: true } as Record<string, unknown> as never),
      ),
    );
    for (const key of [
      'id',
      'tenantId',
      'learningId',
      'version',
      'isCurrent',
      'status',
      'validFrom',
      'recordedAt',
      'recordedByPrincipal',
      'outcomeAssessment',
    ]) {
      expectCode('invalid_learning_input', () =>
        validateRecordCompanyLearningInput(
          learningInput({ [key]: 'smuggled' } as Record<string, unknown> as never),
        ),
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Query validation
// ---------------------------------------------------------------------------

describe('validateListCompanyLearningsQuery', () => {
  it('defaults and normalizes an empty query', () => {
    const valid = validateListCompanyLearningsQuery({});
    expect(valid).toEqual({
      targetKind: null,
      targetId: null,
      aspect: null,
      channel: null,
      validity: null,
      limit: 50,
    });
  });

  it('requires targetKind for targetId and validates the filters', () => {
    expectCode('invalid_query', () => validateListCompanyLearningsQuery({ targetId: SOURCE_ID }));
    expect(() =>
      validateListCompanyLearningsQuery({ targetKind: 'source', targetId: SOURCE_ID }),
    ).not.toThrow();
    expectCode('invalid_query', () => validateListCompanyLearningsQuery({ targetKind: 'topic' as never }));
    expectCode('invalid_query', () => validateListCompanyLearningsQuery({ channel: 'implicit' as never }));
    expectCode('invalid_query', () => validateListCompanyLearningsQuery({ validity: 'terminal' as never }));
    expectCode('invalid_query', () => validateListCompanyLearningsQuery({ aspect: 'Not A Slug' }));
    expectCode('invalid_query', () => validateListCompanyLearningsQuery({ limit: 0 }));
    expectCode('invalid_query', () => validateListCompanyLearningsQuery({ limit: 501 }));
    expect(() => validateListCompanyLearningsQuery({ limit: 500 })).not.toThrow();
  });
});

describe('validateListCompanyLearningVersionsQuery', () => {
  it('requires a uuid learningId', () => {
    expect(() => validateListCompanyLearningVersionsQuery({ learningId: OUTCOME_ID })).not.toThrow();
    expectCode('invalid_query', () => validateListCompanyLearningVersionsQuery({ learningId: 'nope' }));
    expectCode('invalid_query', () => validateListCompanyLearningVersionsQuery({}));
    expectCode('invalid_query', () =>
      validateListCompanyLearningVersionsQuery({ learningId: OUTCOME_ID, extra: 1 } as never),
    );
  });
});

// ---------------------------------------------------------------------------
// The read-time validity derivation
// ---------------------------------------------------------------------------

describe('deriveLearningStatus', () => {
  const at = new Date('2027-03-15T12:00:00Z');

  it('holds forever while valid_until is null', () => {
    expect(deriveLearningStatus(null, at)).toBe('active');
  });

  it('is active through the end of the valid_until day, expired after', () => {
    expect(deriveLearningStatus('2027-03-15', at)).toBe('active'); // same day
    expect(deriveLearningStatus('2027-03-16', at)).toBe('active'); // tomorrow
    expect(deriveLearningStatus('2027-03-14', at)).toBe('expired'); // yesterday
    expect(deriveLearningStatus('2020-01-01', at)).toBe('expired');
    expect(deriveLearningStatus('2099-12-31', at)).toBe('active');
  });

  it('is deterministic in the far past and future regardless of the clock time-of-day', () => {
    const endOfDay = new Date('2027-03-15T23:59:59.999Z');
    const startOfDay = new Date('2027-03-15T00:00:00.001Z');
    expect(deriveLearningStatus('2027-03-15', endOfDay)).toBe('active');
    expect(deriveLearningStatus('2027-03-15', startOfDay)).toBe('active');
    expect(deriveLearningStatus('2027-03-15', at)).toBe('active');
  });
});
