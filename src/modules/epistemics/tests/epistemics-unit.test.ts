// Unit tests for the epistemics module's pure logic (no database): the
// status vocabularies, the canonical contradiction-pair ordering, the full
// validation/normalization surface of claim/contradiction/hypothesis/
// unknown/belief inputs and queries, and the defensive belief-statement
// parser. Storage-level guarantees (immutability triggers, retention
// guards, tenant scoping, evidence enforcement) are covered by
// epistemics-service.test.ts.

import { describe, expect, it } from 'vitest';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { EpistemicsError } from '../errors';
import {
  assertEpistemicsTenantContext,
  BELIEF_STATUSES,
  BELIEF_SUBJECT_KIND,
  CONTRADICTION_STATUSES,
  DEFAULT_LIST_LIMIT,
  EVIDENCE_REF_KINDS,
  HYPOTHESIS_STATUSES,
  isBeliefStatus,
  isContradictionStatus,
  isEvidenceRefKind,
  isHypothesisStatus,
  isResolutionRefKind,
  isUnknownStatus,
  isUuid,
  MAX_ALTERNATIVES,
  MAX_ALTERNATIVE_CHARS,
  MAX_DISCONFIRMATION_CHARS,
  MAX_EVIDENCE_CLAIMS,
  MAX_EVIDENCE_OBSERVATIONS,
  MAX_LIST_LIMIT,
  MAX_NOTE_CHARS,
  MAX_PROPOSITION_CHARS,
  MAX_RATIONALE_CHARS,
  orderEvidenceRefs,
  parseBeliefStatement,
  RESOLUTION_REF_KINDS,
  UNKNOWN_STATUSES,
  validateBeliefInput,
  validateGetBeliefQuery,
  validateGetClaimQuery,
  validateGetContradictionQuery,
  validateGetHypothesisQuery,
  validateGetUnknownQuery,
  validateListBeliefsQuery,
  validateListClaimsQuery,
  validateListContradictionsQuery,
  validateListHypothesesQuery,
  validateListUnknownsQuery,
  validateRecordClaimInput,
  validateRecordHypothesisInput,
  validateRecordUnknownInput,
  validateRegisterContradictionInput,
  validateResolveContradictionInput,
  validateResolveHypothesisInput,
  validateResolveUnknownInput,
  validateRetireBeliefInput,
  validateReviseBeliefInput,
} from '../validation';
import type {
  BeliefInput,
  ListContradictionsQuery,
  RecordClaimInput,
  RegisterContradictionInput,
} from '../types';

const UUID_A = '0b2f8e2a-1c4b-4d8a-9f3e-7a2b6c5d4e8f';
const UUID_B = '1c3a9f4b-2d5c-4e9b-8a4f-8b3c7d6e5f9a';
const UUID_C = '2d4b0a5c-3e6d-4f0a-9b5a-9c4d8e7f6a1b';
const UUID_UPPER = '0B2F8E2A-1C4B-4D8A-9F3E-7A2B6C5D4E8F';
const OBSERVATION_UUID = '3e5c1b7d-4f7e-4a1b-8c6d-ad5e9f8a7b3c';

function expectCode(code: string, fn: () => void): void {
  try {
    fn();
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(EpistemicsError);
    expect((error as EpistemicsError).code).toBe(code);
  }
}

/** A minimal, fully valid claim input. */
function validClaim(): RecordClaimInput {
  return {
    proposition: 'supplier Acme delivers within five business days',
    subject: { kind: 'world.entity', id: UUID_A },
    confidence: { value: 0.8, method: 'evidence_weighing', basis: 'two delivery notes' },
    evidenceObservationIds: [UUID_B, UUID_C],
    rationale: 'derived from delivery notes',
  };
}

/** A minimal, fully valid belief input. */
function validBelief(): BeliefInput {
  return {
    proposition: 'supplier Acme is reliable',
    confidence: { value: 0.7, method: 'bayesian_update' },
    supportingObservationIds: [OBSERVATION_UUID],
    supportingClaimIds: [UUID_A],
    alternatives: ['the good deliveries were cherry-picked'],
    disconfirmation: 'a late delivery observed after this quarter',
    subject: { kind: 'world.entity', id: UUID_B },
    validFrom: '2026-09-14T09:15:00Z',
    rationale: 'initial weighing of delivery evidence',
  };
}

/** A minimal, fully valid contradiction input. */
function validContradiction(): RegisterContradictionInput {
  return {
    left: { kind: 'claim', id: UUID_A },
    right: { kind: 'observation', id: OBSERVATION_UUID },
    note: 'the claim states five days, the observation shows fifteen',
  };
}

describe('vocabularies (ARCHITECTURE.md §4: five distinct concepts)', () => {
  it('declares the canonical lifecycles without duplicates', () => {
    expect([...BELIEF_STATUSES]).toEqual(['active', 'retired']);
    expect([...HYPOTHESIS_STATUSES]).toEqual(['open', 'confirmed', 'refuted']);
    expect([...UNKNOWN_STATUSES]).toEqual(['open', 'resolved']);
    expect([...CONTRADICTION_STATUSES]).toEqual(['open', 'resolved']);
    expect([...EVIDENCE_REF_KINDS]).toEqual(['observation', 'claim']);
    expect([...RESOLUTION_REF_KINDS]).toEqual(['belief', 'claim', 'observation']);
    for (const vocabulary of [BELIEF_STATUSES, HYPOTHESIS_STATUSES, UNKNOWN_STATUSES, CONTRADICTION_STATUSES, EVIDENCE_REF_KINDS, RESOLUTION_REF_KINDS]) {
      expect(new Set(vocabulary).size).toBe(vocabulary.length);
    }
  });

  it('guards recognize members and reject everything else', () => {
    for (const status of BELIEF_STATUSES) expect(isBeliefStatus(status)).toBe(true);
    for (const status of HYPOTHESIS_STATUSES) expect(isHypothesisStatus(status)).toBe(true);
    for (const status of UNKNOWN_STATUSES) expect(isUnknownStatus(status)).toBe(true);
    for (const status of CONTRADICTION_STATUSES) expect(isContradictionStatus(status)).toBe(true);
    for (const kind of EVIDENCE_REF_KINDS) expect(isEvidenceRefKind(kind)).toBe(true);
    for (const kind of RESOLUTION_REF_KINDS) expect(isResolutionRefKind(kind)).toBe(true);
    for (const bad of ['', 'Open', 'archived', 'believe', 42, null, undefined]) {
      expect(isBeliefStatus(bad)).toBe(false);
      expect(isHypothesisStatus(bad)).toBe(false);
      expect(isUnknownStatus(bad)).toBe(false);
      expect(isContradictionStatus(bad)).toBe(false);
      expect(isEvidenceRefKind(bad)).toBe(false);
      expect(isResolutionRefKind(bad)).toBe(false);
    }
  });

  it('reserves the belief subject kind the freshness machinery keys on', () => {
    expect(BELIEF_SUBJECT_KIND).toBe('epistemics.belief');
  });

  it('uuid guard accepts uuids only', () => {
    expect(isUuid(UUID_A)).toBe(true);
    expect(isUuid(UUID_UPPER)).toBe(true);
    for (const bad of ['', 'not-a-uuid', UUID_A.slice(0, 35), 42, null, undefined]) {
      expect(isUuid(bad)).toBe(false);
    }
  });
});

describe('assertEpistemicsTenantContext', () => {
  const good: TenantContext = { tenantId: UUID_A, principalId: UUID_B, authority: [] };

  it('accepts a well-formed context', () => {
    expect(() => assertEpistemicsTenantContext(good)).not.toThrow();
  });

  it('rejects malformed contexts with invalid_context', () => {
    expectCode('invalid_context', () =>
      assertEpistemicsTenantContext({ ...good, tenantId: ' ' }),
    );
    expectCode('invalid_context', () =>
      assertEpistemicsTenantContext({ ...good, principalId: '' }),
    );
    expectCode('invalid_context', () =>
      assertEpistemicsTenantContext({ tenantId: UUID_A, principalId: UUID_B, authority: 'none' as never }),
    );
  });
});

describe('orderEvidenceRefs (canonical contradiction pairs)', () => {
  it('orders by kind first (claim sorts before observation)', () => {
    const claimRef = { kind: 'claim' as const, id: UUID_C };
    const observationRef = { kind: 'observation' as const, id: UUID_A };
    const [a, _b] = orderEvidenceRefs(observationRef, claimRef);
    expect(a).toEqual(claimRef);
  });

  it('orders by id within a kind, regardless of input order', () => {
    const low = { kind: 'observation' as const, id: UUID_A };
    const high = { kind: 'observation' as const, id: UUID_B };
    expect(orderEvidenceRefs(high, low)).toEqual([low, high]);
    expect(orderEvidenceRefs(low, high)).toEqual([low, high]);
  });

  it('is a stable total order (matches the SQL canonical-order CHECK)', () => {
    const refs = [
      { kind: 'claim' as const, id: UUID_B },
      { kind: 'observation' as const, id: UUID_A },
      { kind: 'claim' as const, id: UUID_A },
      { kind: 'observation' as const, id: UUID_B },
    ];
    const sorted = [...refs].sort((x, y) => {
      const [a] = orderEvidenceRefs(x, y);
      return a === x ? -1 : 1;
    });
    expect(sorted.map((ref) => `${ref.kind}:${ref.id}`)).toEqual([
      `claim:${UUID_A}`,
      `claim:${UUID_B}`,
      `observation:${UUID_A}`,
      `observation:${UUID_B}`,
    ]);
  });
});

describe('validateRecordClaimInput', () => {
  it('normalizes a fully valid claim', () => {
    const valid = validateRecordClaimInput({
      ...validClaim(),
      evidenceObservationIds: [UUID_UPPER, UUID_B, UUID_C],
      rationale: undefined,
    });
    expect(valid.proposition).toBe(validClaim().proposition);
    expect(valid.subject).toEqual({ kind: 'world.entity', id: UUID_A });
    expect(valid.confidence).toEqual({
      value: 0.8,
      method: 'evidence_weighing',
      basis: 'two delivery notes',
    });
    // deduplicated, lowercased, sorted
    expect(valid.evidenceObservationIds).toEqual([UUID_A, UUID_B, UUID_C].sort());
    expect(valid.rationale).toBeNull();
  });

  it('rejects caller-smuggled identity/tenancy/lifecycle fields', () => {
    for (const smuggled of ['id', 'tenantId', 'recordedAt', 'status']) {
      expectCode('invalid_claim_input', () =>
        validateRecordClaimInput({
          ...validClaim(),
          [smuggled]: smuggled === 'recordedAt' ? '2026-09-14T09:15:00Z' : newId(),
        } as never),
      );
    }
  });

  it('rejects malformed propositions', () => {
    expectCode('invalid_claim_input', () =>
      validateRecordClaimInput({ ...validClaim(), proposition: '   ' })
    );
    expectCode('invalid_claim_input', () =>
      validateRecordClaimInput({ ...validClaim(), proposition: 'x'.repeat(MAX_PROPOSITION_CHARS + 1) })
    );
    expectCode('invalid_claim_input', () =>
      validateRecordClaimInput({ ...validClaim(), proposition: 42 as never })
    );
  });

  it('rejects malformed confidence', () => {
    for (const bad of [-0.1, 1.0000001, Number.NaN, Number.POSITIVE_INFINITY]) {
      expectCode('invalid_claim_input', () =>
        validateRecordClaimInput({ ...validClaim(), confidence: { value: bad, method: 'x' } })
      );
    }
    expectCode('invalid_claim_input', () =>
      validateRecordClaimInput({ ...validClaim(), confidence: { value: 0.5, method: '' } })
    );
    expectCode('invalid_claim_input', () =>
      validateRecordClaimInput({ ...validClaim(), confidence: { value: 0.5 } as never })
    );
    // boundary values are legal
    expect(() =>
      validateRecordClaimInput({ ...validClaim(), confidence: { value: 0, method: 'none' } })
    ).not.toThrow();
    expect(() =>
      validateRecordClaimInput({ ...validClaim(), confidence: { value: 1, method: 'certain' } })
    ).not.toThrow();
  });

  it('requires at least one supporting observation — claims are derived FROM evidence', () => {
    expectCode('invalid_claim_input', () =>
      validateRecordClaimInput({ ...validClaim(), evidenceObservationIds: [] })
    );
    expectCode('invalid_claim_input', () =>
      validateRecordClaimInput({ ...validClaim(), evidenceObservationIds: 'nope' as never })
    );
    expectCode('invalid_claim_input', () =>
      validateRecordClaimInput({ ...validClaim(), evidenceObservationIds: ['not-a-uuid'] })
    );
    const tooMany = Array.from({ length: MAX_EVIDENCE_OBSERVATIONS + 1 }, () => newId());
    expectCode('invalid_claim_input', () =>
      validateRecordClaimInput({ ...validClaim(), evidenceObservationIds: tooMany })
    );
  });

  it('rejects half-shaped subjects', () => {
    expectCode('invalid_claim_input', () =>
      validateRecordClaimInput({ ...validClaim(), subject: { kind: 'world.entity' } as never })
    );
    expectCode('invalid_claim_input', () =>
      validateRecordClaimInput({ ...validClaim(), subject: { id: UUID_A } as never })
    );
    expectCode('invalid_claim_input', () =>
      validateRecordClaimInput({
        ...validClaim(),
        subject: { kind: 'bad kind!', id: UUID_A },
      })
    );
    expectCode('invalid_claim_input', () =>
      validateRecordClaimInput({
        ...validClaim(),
        subject: { kind: 'world.entity', id: 'not-a-uuid' },
      })
    );
  });

  it('bounds the rationale', () => {
    expectCode('invalid_claim_input', () =>
      validateRecordClaimInput({ ...validClaim(), rationale: 'x'.repeat(MAX_RATIONALE_CHARS + 1) })
    );
  });
});

describe('validateRegisterContradictionInput', () => {
  it('accepts a valid pair and note', () => {
    const valid = validateRegisterContradictionInput(validContradiction());
    expect(valid.left).toEqual({ kind: 'claim', id: UUID_A });
    expect(valid.right).toEqual({ kind: 'observation', id: OBSERVATION_UUID });
    expect(valid.note).toBe(validContradiction().note);
  });

  it('rejects self-contradictions', () => {
    expectCode('invalid_contradiction_input', () =>
      validateRegisterContradictionInput({
        ...validContradiction(),
        right: { kind: 'claim', id: UUID_A },
      })
    );
  });

  it('rejects bad reference kinds and ids', () => {
    expectCode('invalid_contradiction_input', () =>
      validateRegisterContradictionInput({
        ...validContradiction(),
        left: { kind: 'belief', id: UUID_A } as never,
      })
    );
    expectCode('invalid_contradiction_input', () =>
      validateRegisterContradictionInput({
        ...validContradiction(),
        left: { kind: 'claim', id: 'not-a-uuid' },
      })
    );
  });

  it('requires a note describing the conflict', () => {
    expectCode('invalid_contradiction_input', () =>
      validateRegisterContradictionInput({ ...validContradiction(), note: '' })
    );
    expectCode('invalid_contradiction_input', () =>
      validateRegisterContradictionInput({
        ...validContradiction(),
        note: 'x'.repeat(MAX_NOTE_CHARS + 1),
      })
    );
  });

  it('rejects smuggled lifecycle fields', () => {
    expectCode('invalid_contradiction_input', () =>
      validateRegisterContradictionInput({
        ...validContradiction(),
        status: 'resolved',
      } as never)
    );
  });
});

describe('validateResolveContradictionInput', () => {
  it('accepts a resolution with an optional resolvedBy reference', () => {
    const withRef = validateResolveContradictionInput({
      contradictionId: UUID_A,
      resolvedBy: { kind: 'belief', id: UUID_B },
      note: 'newer evidence favors the observation',
    });
    expect(withRef.resolvedBy).toEqual({ kind: 'belief', id: UUID_B });
    const withoutRef = validateResolveContradictionInput({
      contradictionId: UUID_A,
      note: 'the claim turned out to be a data-entry error',
    });
    expect(withoutRef.resolvedBy).toBeNull();
  });

  it('rejects bad ids, kinds and notes', () => {
    expectCode('invalid_resolution', () =>
      validateResolveContradictionInput({ contradictionId: 'nope', note: 'x' })
    );
    expectCode('invalid_resolution', () =>
      validateResolveContradictionInput({
        contradictionId: UUID_A,
        resolvedBy: { kind: 'unknown', id: UUID_B } as never,
        note: 'x',
      })
    );
    expectCode('invalid_resolution', () =>
      validateResolveContradictionInput({ contradictionId: UUID_A, note: ' ' })
    );
  });
});

describe('validateRecordHypothesisInput', () => {
  it('accepts a hypothesis with no supporting evidence', () => {
    const valid = validateRecordHypothesisInput({
      proposition: 'the supplier delays are caused by a single warehouse',
    });
    expect(valid.supportingObservationIds).toEqual([]);
    expect(valid.subject).toBeNull();
    expect(valid.note).toBeNull();
  });

  it('normalizes supporting observations', () => {
    const valid = validateRecordHypothesisInput({
      proposition: 'the delays come from the port authority',
      supportingObservationIds: [UUID_UPPER, UUID_B, UUID_UPPER],
    });
    expect(valid.supportingObservationIds).toEqual([UUID_A, UUID_B].sort());
  });

  it('rejects smuggled lifecycle fields and bad shapes', () => {
    expectCode('invalid_hypothesis_input', () =>
      validateRecordHypothesisInput({
        proposition: 'x',
        status: 'confirmed',
      } as never)
    );
    expectCode('invalid_hypothesis_input', () =>
      validateRecordHypothesisInput({ proposition: '' })
    );
    expectCode('invalid_hypothesis_input', () =>
      validateRecordHypothesisInput({
        proposition: 'x',
        supportingObservationIds: ['not-a-uuid'],
      })
    );
  });
});

describe('validateResolveHypothesisInput', () => {
  it('accepts both outcomes with normalized evidence', () => {
    for (const outcome of ['confirmed', 'refuted'] as const) {
      const valid = validateResolveHypothesisInput({
        hypothesisId: UUID_A,
        outcome,
        evidenceObservationIds: [UUID_B, UUID_A],
        evidenceClaimIds: [UUID_C, UUID_C],
        note: 'the warehouse manager confirmed it',
      });
      expect(valid.outcome).toBe(outcome);
      expect(valid.evidenceObservationIds).toEqual([UUID_A, UUID_B].sort());
      expect(valid.evidenceClaimIds).toEqual([UUID_C]);
    }
  });

  it('rejects vocabulary violations', () => {
    expectCode('invalid_resolution', () =>
      validateResolveHypothesisInput({ hypothesisId: UUID_A, outcome: 'open' as never, note: 'x' })
    );
    expectCode('invalid_resolution', () =>
      validateResolveHypothesisInput({ hypothesisId: UUID_A, outcome: 'confirmed', note: '' })
    );
    expectCode('invalid_resolution', () =>
      validateResolveHypothesisInput({
        hypothesisId: UUID_A,
        outcome: 'confirmed',
        evidenceClaimIds: Array.from({ length: MAX_EVIDENCE_CLAIMS + 1 }, () => newId()),
        note: 'x',
      })
    );
  });
});

describe('validateRecordUnknownInput', () => {
  it('requires BOTH the question and the consequence (lock 7: consequential gaps only)', () => {
    expectCode('invalid_unknown_input', () =>
      validateRecordUnknownInput({ question: 'which warehouse causes the delays?' } as never)
    );
    expectCode('invalid_unknown_input', () =>
      validateRecordUnknownInput({ consequence: 'we cannot fix the delays' } as never)
    );
    const valid = validateRecordUnknownInput({
      question: 'which warehouse causes the delays?',
      consequence: 'without it we cannot fix the delivery slips',
    });
    expect(valid.relatedObservationIds).toEqual([]);
    expect(valid.relatedClaimIds).toEqual([]);
    expect(valid.relatedBeliefIds).toEqual([]);
  });

  it('normalizes related references and rejects smuggled lifecycle fields', () => {
    const valid = validateRecordUnknownInput({
      question: 'which warehouse causes the delays?',
      consequence: 'delivery promises depend on it',
      relatedObservationIds: [UUID_UPPER, UUID_B],
      relatedClaimIds: [UUID_A],
      relatedBeliefIds: [UUID_C],
    });
    expect(valid.relatedObservationIds).toEqual([UUID_A, UUID_B].sort());
    expect(valid.relatedBeliefIds).toEqual([UUID_C]);
    expectCode('invalid_unknown_input', () =>
      validateRecordUnknownInput({
        question: 'q',
        consequence: 'c',
        status: 'resolved',
      } as never)
    );
  });
});

describe('validateResolveUnknownInput', () => {
  it('accepts an optional resolution reference', () => {
    const withRef = validateResolveUnknownInput({
      unknownId: UUID_A,
      resolution: { kind: 'claim', id: UUID_B },
      note: 'the delay source was identified',
    });
    expect(withRef.resolution).toEqual({ kind: 'claim', id: UUID_B });
    const withoutRef = validateResolveUnknownInput({
      unknownId: UUID_A,
      note: 'the question became moot after the contract ended',
    });
    expect(withoutRef.resolution).toBeNull();
  });

  it('rejects bad shapes', () => {
    expectCode('invalid_resolution', () =>
      validateResolveUnknownInput({ unknownId: UUID_A, note: '' })
    );
    expectCode('invalid_resolution', () =>
      validateResolveUnknownInput({
        unknownId: UUID_A,
        resolution: { kind: 'hypothesis', id: UUID_B } as never,
        note: 'x',
      })
    );
  });
});

describe('validateBeliefInput (belief statements — §11, lock 11)', () => {
  it('builds the exact statement the temporal machinery will store', () => {
    const valid = validateBeliefInput({
      ...validBelief(),
      supportingClaimIds: [UUID_UPPER, UUID_A, UUID_UPPER],
      alternatives: ['first', 'first', 'second'],
    });
    expect(valid.statement).toEqual({
      proposition: 'supplier Acme is reliable',
      confidence: { value: 0.7, method: 'bayesian_update', basis: null },
      alternatives: ['first', 'second'],
      disconfirmation: 'a late delivery observed after this quarter',
      supportingClaimIds: [UUID_A],
    });
    expect(valid.supportingObservationIds).toEqual([OBSERVATION_UUID]);
    expect(valid.validFrom).toBe('2026-09-14T09:15:00Z');
    expect(valid.subject).toEqual({ kind: 'world.entity', id: UUID_B });
    expect(valid.rationale).toBe('initial weighing of delivery evidence');
  });

  it('allows a bare statement: no alternatives, no disconfirmation, no claims', () => {
    const valid = validateBeliefInput({
      proposition: 'the office coffee machine is broken',
      confidence: { value: 0.6, method: 'eyewitness' },
      supportingObservationIds: [OBSERVATION_UUID],
      validFrom: '2026-09-14T09:15:00Z',
    });
    expect(valid.statement.alternatives).toEqual([]);
    expect(valid.statement.disconfirmation).toBeNull();
    expect(valid.statement.supportingClaimIds).toEqual([]);
  });

  it('rejects caller-smuggled identity/version/derived fields', () => {
    for (const smuggled of ['id', 'tenantId', 'version', 'recordedAt', 'validTo', 'current', 'status']) {
      expectCode('invalid_belief_input', () =>
        validateBeliefInput({
          ...validBelief(),
          [smuggled]: smuggled === 'version' || smuggled === 'current' ? 2 : newId(),
        } as never),
      );
    }
  });

  it('requires supporting observations on every version (lock 11)', () => {
    expectCode('invalid_belief_input', () =>
      validateBeliefInput({ ...validBelief(), supportingObservationIds: [] })
    );
    expectCode('invalid_belief_input', () =>
      validateBeliefInput({ ...validBelief(), supportingObservationIds: ['nope'] })
    );
  });

  it('bounds alternatives (§11: alternative explanations)', () => {
    expectCode('invalid_belief_input', () =>
      validateBeliefInput({
        ...validBelief(),
        alternatives: Array.from({ length: MAX_ALTERNATIVES + 1 }, () => 'alternative'),
      })
    );
    expectCode('invalid_belief_input', () =>
      validateBeliefInput({
        ...validBelief(),
        alternatives: ['x'.repeat(MAX_ALTERNATIVE_CHARS + 1)],
      })
    );
    expectCode('invalid_belief_input', () =>
      validateBeliefInput({ ...validBelief(), alternatives: ['ok', '  '] })
    );
    expectCode('invalid_belief_input', () =>
      validateBeliefInput({ ...validBelief(), alternatives: 'no' as never })
    );
  });

  it('bounds the disconfirmation (§11: what evidence could change the conclusion)', () => {
    expectCode('invalid_belief_input', () =>
      validateBeliefInput({
        ...validBelief(),
        disconfirmation: 'x'.repeat(MAX_DISCONFIRMATION_CHARS + 1),
      })
    );
  });

  it('requires a strict ISO 8601 validFrom', () => {
    for (const bad of ['2026-09-14 09:15:00Z', '2026-09-14', 42, null]) {
      expectCode('invalid_belief_input', () =>
        validateBeliefInput({ ...validBelief(), validFrom: bad as never })
      );
    }
    expect(() =>
      validateBeliefInput({ ...validBelief(), validFrom: '2026-09-14T09:15:00.123+02:00' })
    ).not.toThrow();
  });

  it('rejects malformed claim references', () => {
    expectCode('invalid_belief_input', () =>
      validateBeliefInput({ ...validBelief(), supportingClaimIds: ['not-a-uuid'] })
    );
    expectCode('invalid_belief_input', () =>
      validateBeliefInput({
        ...validBelief(),
        supportingClaimIds: Array.from({ length: MAX_EVIDENCE_CLAIMS + 1 }, () => newId()),
      })
    );
  });
});

describe('validateReviseBeliefInput / validateRetireBeliefInput', () => {
  it('requires the belief id on revisions', () => {
    expectCode('invalid_belief_input', () => validateReviseBeliefInput(validBelief() as never));
    const valid = validateReviseBeliefInput({ ...validBelief(), beliefId: UUID_UPPER });
    expect(valid.beliefId).toBe(UUID_A);
  });

  it('retirement requires a rationale', () => {
    expectCode('invalid_belief_input', () =>
      validateRetireBeliefInput({ beliefId: UUID_A } as never)
    );
    expectCode('invalid_belief_input', () =>
      validateRetireBeliefInput({ beliefId: UUID_A, rationale: ' ' })
    );
    const valid = validateRetireBeliefInput({
      beliefId: UUID_A,
      rationale: 'the supplier relationship ended; topic retired',
    });
    expect(valid.rationale).toBe('the supplier relationship ended; topic retired');
  });
});

describe('list query validators', () => {
  it('bounds the limit and defaults it', () => {
    const defaults = validateListClaimsQuery({});
    expect(defaults.limit).toBe(DEFAULT_LIST_LIMIT);
    for (const validator of [
      validateListClaimsQuery,
      validateListContradictionsQuery,
      validateListHypothesesQuery,
      validateListUnknownsQuery,
      validateListBeliefsQuery,
    ]) {
      expectCode('invalid_query', () => validator({ limit: 0 }));
      expectCode('invalid_query', () => validator({ limit: MAX_LIST_LIMIT + 1 }));
      expectCode('invalid_query', () => validator({ limit: 1.5 }));
    }
  });

  it('rejects unknown keys', () => {
    expectCode('invalid_query', () => validateListClaimsQuery({ subjectKind: 'x', extra: 1 } as never));
    expectCode('invalid_query', () => validateListContradictionsQuery({ status: 'open', extra: 1 } as never));
    expectCode('invalid_query', () => validateListHypothesesQuery({ subjectId: UUID_A, extra: 1 } as never));
    expectCode('invalid_query', () => validateListUnknownsQuery({ subjectKind: 'x', extra: 1 } as never));
    expectCode('invalid_query', () => validateListBeliefsQuery({ status: 'active', extra: 1 } as never));
  });

  it('validates status filters against the vocabularies', () => {
    expectCode('invalid_query', () =>
      validateListContradictionsQuery({ status: 'merged' as never })
    );
    expectCode('invalid_query', () => validateListHypothesesQuery({ status: 'closed' as never }));
    expectCode('invalid_query', () => validateListUnknownsQuery({ status: 'closed' as never }));
    expectCode('invalid_query', () => validateListBeliefsQuery({ status: 'archived' as never }));
    expect(validateListBeliefsQuery({ status: 'retired' }).status).toBe('retired');
  });

  it('validates the contradiction evidence filter', () => {
    const query: ListContradictionsQuery = {
      evidenceRef: { kind: 'claim', id: UUID_A },
    };
    expect(validateListContradictionsQuery(query).evidenceRef).toEqual({
      kind: 'claim',
      id: UUID_A,
    });
    expectCode('invalid_query', () =>
      validateListContradictionsQuery({ evidenceRef: { kind: 'belief', id: UUID_A } as never })
    );
    expectCode('invalid_query', () =>
      validateListContradictionsQuery({ evidenceRef: { kind: 'claim', id: 'nope' } as never })
    );
  });
});

describe('id query validators (getClaim / getContradiction / getHypothesis / getUnknown / getBelief)', () => {
  it('require a uuid and reject unknown keys', () => {
    expect(validateGetClaimQuery({ claimId: UUID_UPPER })).toBe(UUID_A);
    expect(validateGetContradictionQuery({ contradictionId: UUID_A })).toBe(UUID_A);
    expect(validateGetHypothesisQuery({ hypothesisId: UUID_A })).toBe(UUID_A);
    expect(validateGetUnknownQuery({ unknownId: UUID_A })).toBe(UUID_A);
    expectCode('invalid_query', () => validateGetClaimQuery({ claimId: 'nope' }));
    expectCode('invalid_query', () =>
      validateGetClaimQuery({ claimId: UUID_A, extra: true } as never)
    );
    expectCode('invalid_query', () => validateGetBeliefQuery({ beliefId: null as never }));
    expectCode('invalid_query', () => validateGetBeliefQuery('nope' as never));
  });

  it('getBelief validates the asOf instant strictly', () => {
    expectCode('invalid_query', () =>
      validateGetBeliefQuery({ beliefId: UUID_A, asOf: '2026-09-14' })
    );
    expectCode('invalid_query', () =>
      validateGetBeliefQuery({ beliefId: UUID_A, asOf: 'not a date' })
    );
    const withAsOf = validateGetBeliefQuery({
      beliefId: UUID_A,
      asOf: '2026-09-14T09:15:00.000Z',
    });
    expect(withAsOf.asOf?.toISOString()).toBe('2026-09-14T09:15:00.000Z');
    expect(validateGetBeliefQuery({ beliefId: UUID_A }).asOf).toBeNull();
  });
});

describe('parseBeliefStatement (defensive read-back of versioned state)', () => {
  it('round-trips a statement this module would store', () => {
    const statement = validateBeliefInput(validBelief()).statement;
    expect(parseBeliefStatement(JSON.parse(JSON.stringify(statement)))).toEqual(statement);
  });

  it('surfaces foreign/garbage states as belief_state_corrupt', () => {
    for (const bad of [
      null,
      42,
      'text',
      [],
      {},
      { proposition: 'x' },
      { proposition: 'x', confidence: { value: 0.5 }, alternatives: [], supportingClaimIds: [] },
      { proposition: 'x', confidence: { value: 0.5, method: 'm' }, alternatives: 'no', supportingClaimIds: [] },
      { proposition: 'x', confidence: { value: 0.5, method: 'm' }, alternatives: [], supportingClaimIds: 'no' },
      { proposition: 'x', confidence: { value: 0.5, method: 'm' }, alternatives: [], disconfirmation: 3, supportingClaimIds: [] },
    ]) {
      expectCode('belief_state_corrupt', () => parseBeliefStatement(bad));
    }
  });
});
