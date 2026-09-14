// Unit tests for the freshness module's pure logic (no database): the
// status vocabulary, the pure temporal math (latency / age / classification),
// the TenantContext shape, and the full validation/normalization surface of
// policy inputs, revision inputs and queries. Storage-level guarantees
// (append-only revisions, tenant scoping, provenance enforcement) are
// covered by freshness-service.test.ts.

import { describe, expect, it } from 'vitest';
import { newId } from '@/infra/ids';
import {
  classifyFreshness,
  evidenceAgeSeconds,
  observationLatencySeconds,
} from '../classification';
import { FreshnessError } from '../errors';
import {
  assertFreshnessTenantContext,
  DEFAULT_POLICY_LIST_LIMIT,
  FRESHNESS_STATUSES,
  isFreshnessStatus,
  isUuid,
  MAX_POLICY_LIST_LIMIT,
  MAX_PROVENANCE_OBSERVATIONS,
  SOURCE_SUBJECT_KIND,
  validateGetTemporalStateQuery,
  validateHistoryQuery,
  validateListPoliciesQuery,
  validateObservationFreshnessQuery,
  validatePolicySubjectQuery,
  validateRecordRevisionInput,
  validateSetFreshnessPolicyInput,
  validateSourceFreshnessQuery,
  validateTemporalStateFreshnessQuery,
} from '../validation';
import type {
  GetTemporalStateQuery,
  ListFreshnessPoliciesQuery,
  ObservationFreshnessQuery,
  RecordTemporalRevisionInput,
  SetFreshnessPolicyInput,
  SourceFreshnessQuery,
  TemporalStateFreshnessQuery,
} from '../types';

const UUID_A = '0b2f8e2a-1c4b-4d8a-9f3e-7a2b6c5d4e8f';
const UUID_B = '1c3a9f4b-2d5c-4e9b-8a4f-8b3c7d6e5f9a';
const UUID_UPPER = '0B2F8E2A-1C4B-4D8A-9F3E-7A2B6C5D4E8F';

function expectCode(code: string, fn: () => void): void {
  try {
    fn();
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(FreshnessError);
    expect((error as FreshnessError).code).toBe(code);
  }
}

/** A minimal, fully valid policy input. */
function validPolicy(): SetFreshnessPolicyInput {
  return { subjectKind: 'source', staleAfterSeconds: 3600 };
}

/** A minimal, fully valid revision input. */
function validRevision(): RecordTemporalRevisionInput {
  return {
    subjectKind: 'world.relationship',
    subjectId: UUID_A,
    state: { strength: 'strong', notes: 'supplier-of-record' },
    validFrom: '2026-09-14T09:15:00Z',
    observationIds: [UUID_B],
  };
}

describe('vocabularies (ARCHITECTURE.md §11: current / aging / stale)', () => {
  it('declares the canonical statuses without duplicates', () => {
    expect([...FRESHNESS_STATUSES]).toEqual(['current', 'aging', 'stale', 'unknown']);
    expect(new Set(FRESHNESS_STATUSES).size).toBe(FRESHNESS_STATUSES.length);
  });

  it('guards recognize members and reject everything else', () => {
    for (const status of FRESHNESS_STATUSES) expect(isFreshnessStatus(status)).toBe(true);
    for (const bad of ['', 'Current', 'fresh', 'staler', 42, null, undefined]) {
      expect(isFreshnessStatus(bad)).toBe(false);
    }
  });

  it('reserves the source subject kind for source-scoped policies', () => {
    expect(SOURCE_SUBJECT_KIND).toBe('source');
  });
});

describe('classifyFreshness (stale-after semantics)', () => {
  it('returns unknown without thresholds (no applicable policy)', () => {
    expect(classifyFreshness(null, 0)).toBe('unknown');
    expect(classifyFreshness(null, 1_000_000)).toBe('unknown');
  });

  it('classifies current vs stale without an aging threshold', () => {
    const thresholds = { staleAfterSeconds: 3600 };
    expect(classifyFreshness(thresholds, 0)).toBe('current');
    expect(classifyFreshness(thresholds, 3599.999)).toBe('current');
    // "stale-after N seconds" is strict: at exactly N it is not yet stale
    expect(classifyFreshness(thresholds, 3600)).toBe('current');
    expect(classifyFreshness(thresholds, 3600.001)).toBe('stale');
    expect(classifyFreshness(thresholds, 7200)).toBe('stale');
  });

  it('classifies current / aging / stale with an aging threshold', () => {
    const thresholds = { staleAfterSeconds: 3600, agingAfterSeconds: 600 };
    expect(classifyFreshness(thresholds, 0)).toBe('current');
    expect(classifyFreshness(thresholds, 600)).toBe('current'); // inclusive bound
    expect(classifyFreshness(thresholds, 600.001)).toBe('aging');
    expect(classifyFreshness(thresholds, 3599.999)).toBe('aging');
    expect(classifyFreshness(thresholds, 3600)).toBe('aging'); // still not stale at exactly N
    expect(classifyFreshness(thresholds, 3600.001)).toBe('stale');
  });

  it('treats a null aging threshold as absent', () => {
    expect(classifyFreshness({ staleAfterSeconds: 60, agingAfterSeconds: null }, 61)).toBe('stale');
    expect(classifyFreshness({ staleAfterSeconds: 60, agingAfterSeconds: null }, 30)).toBe('current');
  });

  it('clamps negative ages to current (future-dated evidence is not negatively aged)', () => {
    expect(classifyFreshness({ staleAfterSeconds: 10 }, -5)).toBe('current');
    expect(classifyFreshness({ staleAfterSeconds: 10, agingAfterSeconds: 1 }, -5)).toBe('current');
  });
});

describe('observationLatencySeconds (recordedAt − observedAt)', () => {
  it('derives whole-second latency', () => {
    expect(
      observationLatencySeconds('2026-09-14T09:15:00Z', '2026-09-14T09:16:30Z'),
    ).toBe(90);
  });

  it('keeps fractional seconds', () => {
    expect(
      observationLatencySeconds('2026-09-14T09:15:00Z', '2026-09-14T09:15:00.500Z'),
    ).toBe(0.5);
  });

  it('respects offsets (both instants normalize to UTC)', () => {
    expect(
      observationLatencySeconds('2026-09-14T11:15:00+02:00', '2026-09-14T09:16:00Z'),
    ).toBe(60);
  });

  it('clamps source-clock skew (observedAt after recordedAt) to zero', () => {
    expect(
      observationLatencySeconds('2026-09-14T09:16:00Z', '2026-09-14T09:15:00Z'),
    ).toBe(0);
  });
});

describe('evidenceAgeSeconds (asOf − observedAt)', () => {
  it('derives the age of evidence at an evaluation instant', () => {
    expect(evidenceAgeSeconds('2026-09-14T09:15:00Z', '2026-09-14T10:15:00Z')).toBe(3600);
    expect(evidenceAgeSeconds('2026-09-14T09:15:00Z', '2026-09-14T09:15:30Z')).toBe(30);
  });

  it('clamps future-dated evidence to zero', () => {
    expect(evidenceAgeSeconds('2026-09-14T10:00:00Z', '2026-09-14T09:00:00Z')).toBe(0);
  });
});

describe('TenantContext shape (explicit context, no ambient state)', () => {
  it('accepts a well-formed context', () => {
    expect(() =>
      assertFreshnessTenantContext({ tenantId: newId(), principalId: newId(), authority: [] }),
    ).not.toThrow();
  });

  it('rejects malformed contexts with invalid_context', () => {
    expectCode('invalid_context', () =>
      assertFreshnessTenantContext({ tenantId: '', principalId: newId(), authority: [] }),
    );
    expectCode('invalid_context', () =>
      assertFreshnessTenantContext({ tenantId: newId(), principalId: '  ', authority: [] }),
    );
    expectCode('invalid_context', () =>
      assertFreshnessTenantContext({ tenantId: newId(), principalId: newId(), authority: 'admin' as unknown as string[] }),
    );
  });
});

describe('validateSetFreshnessPolicyInput', () => {
  it('applies the documented defaults', () => {
    const validated = validateSetFreshnessPolicyInput(validPolicy());
    expect(validated.subjectId).toBeNull();
    expect(validated.agingAfterSeconds).toBeNull();
    expect(validated.maxLatencySeconds).toBeNull();
    expect(validated.note).toBeNull();
    expect(validated.staleAfterSeconds).toBe(3600);
  });

  it('accepts the full surface and normalizes ids and notes', () => {
    const validated = validateSetFreshnessPolicyInput({
      subjectKind: 'epistemics.belief',
      subjectId: UUID_UPPER,
      staleAfterSeconds: 86_400,
      agingAfterSeconds: 3_600,
      maxLatencySeconds: 600,
      note: '  daily-refresh beliefs  ',
    });
    expect(validated.subjectKind).toBe('epistemics.belief');
    expect(validated.subjectId).toBe(UUID_A); // lowercased
    expect(validated.agingAfterSeconds).toBe(3_600);
    expect(validated.maxLatencySeconds).toBe(600);
    expect(validated.note).toBe('daily-refresh beliefs');
  });

  it('treats explicit nulls for optional fields as absent', () => {
    const validated = validateSetFreshnessPolicyInput({
      ...validPolicy(),
      subjectId: null,
      agingAfterSeconds: null,
      maxLatencySeconds: null,
      note: null,
    });
    expect(validated.subjectId).toBeNull();
    expect(validated.agingAfterSeconds).toBeNull();
    expect(validated.maxLatencySeconds).toBeNull();
    expect(validated.note).toBeNull();
  });

  it('rejects smuggled identity/tenancy/timestamp fields', () => {
    for (const smuggled of ['id', 'tenantId', 'createdAt', 'updatedAt']) {
      const input = { ...validPolicy(), [smuggled]: newId() } as unknown as SetFreshnessPolicyInput;
      expectCode('invalid_policy_input', () => validateSetFreshnessPolicyInput(input));
    }
  });

  it('rejects a non-object input', () => {
    expectCode('invalid_policy_input', () =>
      validateSetFreshnessPolicyInput(null as unknown as SetFreshnessPolicyInput),
    );
    expectCode('invalid_policy_input', () =>
      validateSetFreshnessPolicyInput('policy' as unknown as SetFreshnessPolicyInput),
    );
  });

  it('rejects malformed subject kinds and subject ids', () => {
    // (kinds are case-tolerant slugs by design — 'Source' is well-formed)
    for (const subjectKind of ['', 'has space', '.leading', 'x'.repeat(130), 42]) {
      expectCode('invalid_policy_input', () =>
        validateSetFreshnessPolicyInput({ ...validPolicy(), subjectKind: subjectKind as unknown as string }),
      );
    }
    expectCode('invalid_policy_input', () =>
      validateSetFreshnessPolicyInput({ ...validPolicy(), subjectId: 'not-a-uuid' }),
    );
  });

  it('rejects invalid second values', () => {
    for (const staleAfterSeconds of [0, -1, 1.5, '60', Number.NaN, null]) {
      expectCode('invalid_policy_input', () =>
        validateSetFreshnessPolicyInput({ ...validPolicy(), staleAfterSeconds: staleAfterSeconds as unknown as number }),
      );
    }
    // must fit the PostgreSQL integer column
    expect(
      validateSetFreshnessPolicyInput({ ...validPolicy(), staleAfterSeconds: 2_147_483_647 })
        .staleAfterSeconds,
    ).toBe(2_147_483_647);
    expectCode('invalid_policy_input', () =>
      validateSetFreshnessPolicyInput({ ...validPolicy(), staleAfterSeconds: 2_147_483_648 }),
    );
  });

  it('rejects an aging threshold that is not strictly below the stale threshold', () => {
    expectCode('invalid_policy_input', () =>
      validateSetFreshnessPolicyInput({ ...validPolicy(), agingAfterSeconds: 3600 }),
    );
    expectCode('invalid_policy_input', () =>
      validateSetFreshnessPolicyInput({ ...validPolicy(), agingAfterSeconds: 3601 }),
    );
    expect(
      validateSetFreshnessPolicyInput({ ...validPolicy(), agingAfterSeconds: 3599 }).agingAfterSeconds,
    ).toBe(3599);
    for (const agingAfterSeconds of [0, -1, 2.5]) {
      expectCode('invalid_policy_input', () =>
        validateSetFreshnessPolicyInput({ ...validPolicy(), agingAfterSeconds: agingAfterSeconds as unknown as number }),
      );
    }
  });

  it('rejects an invalid max-latency threshold and oversized notes', () => {
    expectCode('invalid_policy_input', () =>
      validateSetFreshnessPolicyInput({ ...validPolicy(), maxLatencySeconds: 0 }),
    );
    expectCode('invalid_policy_input', () =>
      validateSetFreshnessPolicyInput({ ...validPolicy(), maxLatencySeconds: -5 }),
    );
    expectCode('invalid_policy_input', () =>
      validateSetFreshnessPolicyInput({ ...validPolicy(), note: 'x'.repeat(513) }),
    );
  });
});

describe('validateRecordRevisionInput', () => {
  it('accepts a full revision and normalizes provenance and rationale', () => {
    const validated = validateRecordRevisionInput({
      ...validRevision(),
      observationIds: [UUID_UPPER, UUID_B, UUID_A],
      rationale: '  quarterly review outcome  ',
    });
    expect(validated.subjectKind).toBe('world.relationship');
    expect(validated.subjectId).toBe(UUID_A);
    expect(validated.validFrom).toBe('2026-09-14T09:15:00Z');
    // provenance is a set: deduplicated (case-insensitively) and sorted
    expect(validated.observationIds).toEqual([UUID_A, UUID_B]);
    expect(validated.rationale).toBe('quarterly review outcome');
  });

  it('defaults the rationale to null', () => {
    expect(validateRecordRevisionInput(validRevision()).rationale).toBeNull();
  });

  it('rejects smuggled identity/version/tenancy/derived fields (system-minted only)', () => {
    for (const smuggled of ['id', 'tenantId', 'version', 'recordedAt', 'validTo', 'current']) {
      const input = {
        ...validRevision(),
        [smuggled]: smuggled === 'version' || smuggled === 'current' ? 2 : newId(),
      } as unknown as RecordTemporalRevisionInput;
      expectCode('invalid_revision_input', () => validateRecordRevisionInput(input));
    }
  });

  it('rejects a non-object input', () => {
    expectCode('invalid_revision_input', () =>
      validateRecordRevisionInput(null as unknown as RecordTemporalRevisionInput),
    );
    expectCode('invalid_revision_input', () =>
      validateRecordRevisionInput(42 as unknown as RecordTemporalRevisionInput),
    );
  });

  it('requires provenance — no versioned understanding without evidence (lock 11)', () => {
    expectCode('invalid_revision_input', () =>
      validateRecordRevisionInput({ ...validRevision(), observationIds: [] }),
    );
    expectCode('invalid_revision_input', () =>
      validateRecordRevisionInput({ ...validRevision(), observationIds: undefined as unknown as string[] }),
    );
    expectCode('invalid_revision_input', () =>
      validateRecordRevisionInput({ ...validRevision(), observationIds: 'nope' as unknown as string[] }),
    );
    expectCode('invalid_revision_input', () =>
      validateRecordRevisionInput({ ...validRevision(), observationIds: ['not-a-uuid'] }),
    );
    expectCode('invalid_revision_input', () =>
      validateRecordRevisionInput({
        ...validRevision(),
        observationIds: Array.from({ length: MAX_PROVENANCE_OBSERVATIONS + 1 }, () => newId()),
      }),
    );
  });

  it('accepts any plain JSON state and rejects non-JSON or oversized states', () => {
    for (const state of ['text', 42, true, { nested: { deep: [1, 2, { x: null }] } }, [1, 2, 3]]) {
      expect(validateRecordRevisionInput({ ...validRevision(), state }).state).toEqual(state);
    }
    for (const state of [
      null,
      undefined,
      () => 1,
      Symbol('no'),
      10n,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      new Date('2026-01-01T00:00:00Z'),
      new Map(),
      { nested: { fn: () => 1 } },
    ]) {
      expectCode('invalid_revision_input', () =>
        validateRecordRevisionInput({ ...validRevision(), state: state as unknown as unknown }),
      );
    }
    expectCode('invalid_revision_input', () =>
      validateRecordRevisionInput({ ...validRevision(), state: { big: 'x'.repeat(1_048_577) } }),
    );
  });

  it('requires a strict ISO 8601 validFrom with explicit offset', () => {
    for (const validFrom of [
      '2026-09-14T09:15:00Z',
      '2026-09-14T09:15:00.123Z',
      '2026-09-14T11:15:00+02:00',
      '2026-09-14T05:15:00-04:00',
    ]) {
      expect(validateRecordRevisionInput({ ...validRevision(), validFrom }).validFrom).toBe(validFrom);
    }
    for (const validFrom of [
      '',
      '2026-09-14',
      '2026-09-14 09:15:00Z',
      '2026-09-14T09:15:00', // no offset
      'not-a-date',
      1726300500000,
    ]) {
      expectCode('invalid_revision_input', () =>
        validateRecordRevisionInput({ ...validRevision(), validFrom: validFrom as unknown as string }),
      );
    }
  });

  it('rejects malformed subject kinds, subject ids and rationales', () => {
    expectCode('invalid_revision_input', () =>
      validateRecordRevisionInput({ ...validRevision(), subjectKind: 'not a kind' }),
    );
    expectCode('invalid_revision_input', () =>
      validateRecordRevisionInput({ ...validRevision(), subjectId: 'nope' }),
    );
    expectCode('invalid_revision_input', () =>
      validateRecordRevisionInput({ ...validRevision(), rationale: 'x'.repeat(513) }),
    );
  });
});

describe('validateGetTemporalStateQuery / validateTemporalStateFreshnessQuery', () => {
  const subjectQuery = { subjectKind: 'world.relationship', subjectId: UUID_A };

  it('defaults asOf to null (the service uses the clock)', () => {
    expect(validateGetTemporalStateQuery(subjectQuery as GetTemporalStateQuery).asOf).toBeNull();
    expect(
      validateTemporalStateFreshnessQuery(subjectQuery as TemporalStateFreshnessQuery).asOf,
    ).toBeNull();
  });

  it('accepts a strict ISO asOf and parses it', () => {
    const validated = validateGetTemporalStateQuery({
      ...subjectQuery,
      asOf: '2026-09-14T12:00:00Z',
    } as GetTemporalStateQuery);
    expect(validated.asOf).toEqual(new Date('2026-09-14T12:00:00Z'));
  });

  it('rejects unknown fields, bad subjects and ambiguous asOf', () => {
    expectCode('invalid_query', () =>
      validateGetTemporalStateQuery({ ...subjectQuery, nope: 1 } as unknown as GetTemporalStateQuery),
    );
    expectCode('invalid_query', () =>
      validateGetTemporalStateQuery({ ...subjectQuery, subjectId: 'nope' } as unknown as GetTemporalStateQuery),
    );
    expectCode('invalid_query', () =>
      validateGetTemporalStateQuery({ ...subjectQuery, asOf: '2026-09-14' } as GetTemporalStateQuery),
    );
    expectCode('invalid_query', () =>
      validateTemporalStateFreshnessQuery({ ...subjectQuery, asOf: 42 } as unknown as TemporalStateFreshnessQuery),
    );
  });

  it('isUuid accepts any uuid shape and rejects the rest', () => {
    expect(isUuid(UUID_A)).toBe(true);
    expect(isUuid(UUID_UPPER)).toBe(true);
    expect(isUuid(newId())).toBe(true);
    for (const bad of ['', 'not-a-uuid', `${UUID_A}-extra`, 42, null, undefined]) {
      expect(isUuid(bad)).toBe(false);
    }
  });
});

describe('validateHistoryQuery', () => {
  it('accepts the subject and rejects any extra field (no asOf on history)', () => {
    const query = { subjectKind: 'world.relationship', subjectId: UUID_A };
    expect(validateHistoryQuery(query)).toEqual(query);
    expectCode('invalid_query', () =>
      validateHistoryQuery({ ...query, asOf: '2026-09-14T12:00:00Z' } as never),
    );
  });
});

describe('validatePolicySubjectQuery', () => {
  it('normalizes an absent subject id to the kind default', () => {
    expect(
      validatePolicySubjectQuery({ subjectKind: 'source', subjectId: undefined }),
    ).toEqual({ subjectKind: 'source', subjectId: null });
    expect(validatePolicySubjectQuery({ subjectKind: 'source' })).toEqual({
      subjectKind: 'source',
      subjectId: null,
    });
    expect(validatePolicySubjectQuery({ subjectKind: 'source', subjectId: null })).toEqual({
      subjectKind: 'source',
      subjectId: null,
    });
  });

  it('normalizes a uuid subject id and rejects malformed input', () => {
    expect(validatePolicySubjectQuery({ subjectKind: 'source', subjectId: UUID_UPPER })).toEqual({
      subjectKind: 'source',
      subjectId: UUID_A,
    });
    expectCode('invalid_query', () =>
      validatePolicySubjectQuery({ subjectKind: 'source', subjectId: 'nope' }),
    );
    expectCode('invalid_query', () => validatePolicySubjectQuery({ subjectKind: 'source?' }));
    expectCode('invalid_query', () =>
      validatePolicySubjectQuery({ subjectKind: 'source', extra: 1 } as never),
    );
  });
});

describe('validateListPoliciesQuery', () => {
  it('defaults the limit and accepts a subject-kind filter', () => {
    expect(validateListPoliciesQuery({})).toEqual({
      subjectKind: null,
      limit: DEFAULT_POLICY_LIST_LIMIT,
    });
    expect(validateListPoliciesQuery({ subjectKind: 'source' })).toEqual({
      subjectKind: 'source',
      limit: DEFAULT_POLICY_LIST_LIMIT,
    });
  });

  it('bounds the limit and rejects unknown fields', () => {
    expect(validateListPoliciesQuery({ limit: MAX_POLICY_LIST_LIMIT }).limit).toBe(
      MAX_POLICY_LIST_LIMIT,
    );
    for (const limit of [0, -1, MAX_POLICY_LIST_LIMIT + 1, 1.5, '10']) {
      expectCode('invalid_query', () =>
        validateListPoliciesQuery({ limit: limit as unknown as number } as ListFreshnessPoliciesQuery),
      );
    }
    expectCode('invalid_query', () => validateListPoliciesQuery({ nope: 1 } as never));
    expectCode('invalid_query', () =>
      validateListPoliciesQuery({ subjectKind: 'not a kind' } as ListFreshnessPoliciesQuery),
    );
  });
});

describe('validateObservationFreshnessQuery', () => {
  it('accepts an observation id with an optional asOf', () => {
    expect(
      validateObservationFreshnessQuery({ observationId: UUID_A } as ObservationFreshnessQuery),
    ).toEqual({ observationId: UUID_A, asOf: null });
    expect(
      validateObservationFreshnessQuery({
        observationId: UUID_UPPER,
        asOf: '2026-09-14T12:00:00Z',
      } as ObservationFreshnessQuery),
    ).toEqual({ observationId: UUID_A, asOf: new Date('2026-09-14T12:00:00Z') });
  });

  it('rejects malformed ids, unknown fields and bad asOf', () => {
    expectCode('invalid_query', () =>
      validateObservationFreshnessQuery({ observationId: 'nope' } as never),
    );
    expectCode('invalid_query', () =>
      validateObservationFreshnessQuery({ observationId: UUID_A, extra: 1 } as never),
    );
    expectCode('invalid_query', () =>
      validateObservationFreshnessQuery({ observationId: UUID_A, asOf: 'nope' } as never),
    );
  });
});

describe('validateSourceFreshnessQuery', () => {
  it('accepts a canonical source kind with a uuid source id', () => {
    expect(
      validateSourceFreshnessQuery({ sourceKind: 'source', sourceId: UUID_A } as SourceFreshnessQuery),
    ).toEqual({ sourceKind: 'source', sourceId: UUID_A, asOf: null });
    expect(
      validateSourceFreshnessQuery({
        sourceKind: 'person',
        sourceId: UUID_UPPER,
        asOf: '2026-09-14T12:00:00Z',
      } as SourceFreshnessQuery),
    ).toEqual({ sourceKind: 'person', sourceId: UUID_A, asOf: new Date('2026-09-14T12:00:00Z') });
  });

  it('rejects unknown kinds, malformed ids and unknown fields', () => {
    expectCode('invalid_query', () =>
      validateSourceFreshnessQuery({ sourceKind: 'mystery', sourceId: UUID_A } as never),
    );
    expectCode('invalid_query', () =>
      validateSourceFreshnessQuery({ sourceKind: 'source', sourceId: 'nope' } as never),
    );
    expectCode('invalid_query', () =>
      validateSourceFreshnessQuery({ sourceKind: 'source', sourceId: UUID_A, nope: 1 } as never),
    );
    expectCode('invalid_query', () =>
      validateSourceFreshnessQuery({ sourceId: UUID_A } as never), // kind is required
    );
  });
});
