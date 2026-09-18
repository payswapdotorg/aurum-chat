// Unit tests for the opportunities module's PURE logic — derivation.ts and
// validation.ts (no database): the deterministic function from cited
// evidence confidences to an opportunity's confidence, the canonical
// evidence-set fingerprint, the recordability policy gate, and the input
// guards that keep audit fields un-forgeable and derived fields
// un-suppliable.

import { describe, expect, it } from 'vitest';
import {
  CONFIDENCE_CAP,
  CORROBORATION_STEP,
  deriveConfidence,
  evaluateRecordability,
  evidenceFingerprintOf,
  round4,
} from '../derivation';
import {
  DEFAULT_MIN_CONFIDENCE,
  MAX_CANDIDATES_PER_RUN,
  MAX_EVIDENCE_REFS,
  MAX_VALUE_AMOUNT,
  validateConvertSignalsInput,
  validatePolicy,
  validateReviseOpportunityInput,
} from '../validation';
import { OpportunitiesError } from '../errors';
import type { ConvertSignalsInput, ReviseOpportunityInput, SignalCandidateInput } from '../types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const OBS_1 = '00000000-0000-4000-8000-00000000aa01';
const OBS_2 = '00000000-0000-4000-8000-00000000aa02';
const CLAIM_1 = '00000000-0000-4000-8000-00000000bb01';
const GOAL_1 = '10000000-0000-4000-8000-000000000001';
const EXECUTION_1 = '20000000-0000-4000-8000-000000000001';
const CAPABILITY_1 = '30000000-0000-4000-8000-000000000001';
const ENTITY_1 = '40000000-0000-4000-8000-000000000001';

function snap(kind: 'observation' | 'claim', id: string, value: number) {
  return { kind, id, value };
}

/** A minimal well-formed candidate (override what each test cares about). */
function candidate(overrides: Partial<SignalCandidateInput> = {}): SignalCandidateInput {
  return {
    title: 'Expand document processing into DACH',
    description: 'Three external signals show unserved demand.',
    signalOrigin: 'external',
    evidence: { observationIds: [OBS_1], claimIds: [CLAIM_1] },
    estimatedValue: { amount: 250_000_00, currency: 'EUR' },
    affectedGoals: [{ goalId: GOAL_1 }],
    requiredCapabilities: [{ capabilityId: CAPABILITY_1, label: 'German-language document processing' }],
    worldEntities: [{ entityId: ENTITY_1, label: 'DACH market' }],
    recommendedNextAction: { kind: 'recommend', statement: 'Put the DACH expansion on the next board agenda.' },
    ...overrides,
  };
}

function runInput(overrides: Partial<ConvertSignalsInput> = {}): ConvertSignalsInput {
  return {
    trigger: { kind: 'scheduled' },
    policy: { minConfidence: 0.5, minValue: { amount: 100_000_00, currency: 'EUR' } },
    candidates: [candidate()],
    actor: { kind: 'system', id: 'cognition-worker' },
    rationale: 'nightly sweep',
    ...overrides,
  };
}

/** Sync error-code assertion for the pure validators. */
function expectSyncCode(code: string, fn: () => unknown): void {
  try {
    fn();
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(OpportunitiesError);
    expect((error as OpportunitiesError).code).toBe(code);
  }
}

// ---------------------------------------------------------------------------
// derivation.ts — deriveConfidence
// ---------------------------------------------------------------------------

describe('deriveConfidence', () => {
  it('is the weakest evidence confidence for a single reference', () => {
    expect(deriveConfidence([snap('observation', OBS_1, 0.8)])).toBe(0.8);
    expect(deriveConfidence([snap('claim', CLAIM_1, 0.25)])).toBe(0.25);
  });

  it('starts from the WEAKEST cited confidence, whatever the order', () => {
    const a = [snap('observation', OBS_1, 0.9), snap('claim', CLAIM_1, 0.4)];
    const b = [snap('claim', CLAIM_1, 0.4), snap('observation', OBS_1, 0.9)];
    expect(deriveConfidence(a)).toBe(deriveConfidence(b));
    expect(deriveConfidence(a)).toBe(round4(0.4 + CORROBORATION_STEP));
  });

  it('adds one bounded corroboration step per additional distinct reference', () => {
    const confidences = [
      snap('observation', OBS_1, 0.6),
      snap('observation', OBS_2, 0.6),
      snap('claim', CLAIM_1, 0.6),
    ];
    expect(deriveConfidence(confidences)).toBe(round4(0.6 + 2 * CORROBORATION_STEP));
  });

  it('caps derived confidence below certainty', () => {
    const many = Array.from({ length: 16 }, (_, i) =>
      snap('observation', `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, 0.95),
    );
    expect(deriveConfidence(many)).toBe(CONFIDENCE_CAP);
  });

  it('never exceeds the cap even with maximum evidence and confidence', () => {
    expect(deriveConfidence([snap('observation', OBS_1, 1)])).toBe(CONFIDENCE_CAP);
  });

  it('stays low when the weakest evidence is weak, however much corroborates', () => {
    const confidences = [
      snap('observation', OBS_1, 0.05),
      ...Array.from({ length: 15 }, (_, i) =>
        snap('claim', `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, 0.99),
      ),
    ];
    expect(deriveConfidence(confidences)).toBe(round4(0.05 + 15 * CORROBORATION_STEP));
  });

  it('is total on the empty basis (0 — the validation layer refuses that case)', () => {
    expect(deriveConfidence([])).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// derivation.ts — evidenceFingerprintOf
// ---------------------------------------------------------------------------

describe('evidenceFingerprintOf', () => {
  it('is order-insensitive within each evidence list', () => {
    expect(evidenceFingerprintOf([OBS_1, OBS_2], [CLAIM_1])).toBe(
      evidenceFingerprintOf([OBS_2, OBS_1], [CLAIM_1]),
    );
  });

  it('distinguishes observation ids from claim ids', () => {
    expect(evidenceFingerprintOf([OBS_1], [])).not.toBe(evidenceFingerprintOf([], [OBS_1]));
  });

  it('distinguishes different signal sets', () => {
    expect(evidenceFingerprintOf([OBS_1], [CLAIM_1])).not.toBe(
      evidenceFingerprintOf([OBS_1, OBS_2], [CLAIM_1]),
    );
    expect(evidenceFingerprintOf([OBS_1], [])).not.toBe(evidenceFingerprintOf([], [CLAIM_1]));
  });

  it('has the documented canonical shape', () => {
    expect(evidenceFingerprintOf([OBS_2, OBS_1], [])).toBe(`obs:${OBS_1},${OBS_2}|claims:`);
    expect(evidenceFingerprintOf([], [CLAIM_1])).toBe(`obs:|claims:${CLAIM_1}`);
  });
});

// ---------------------------------------------------------------------------
// derivation.ts — evaluateRecordability (the policy gate)
// ---------------------------------------------------------------------------

describe('evaluateRecordability', () => {
  const policy = { minConfidence: 0.5, minValue: { amount: 100_000_00, currency: 'EUR' } };

  it('converts a candidate above both gates', () => {
    const decision = evaluateRecordability(policy, 0.7, { amount: 250_000_00, currency: 'EUR' });
    expect(decision.disposition).toBe('converted');
    expect(decision.reason).toBeNull();
  });

  it('records currency_mismatch when the value gate is set in another currency', () => {
    const decision = evaluateRecordability(policy, 0.9, { amount: 250_000_00, currency: 'USD' });
    expect(decision.disposition).toBe('currency_mismatch');
    expect(decision.reason).toContain('EUR');
    expect(decision.reason).toContain('USD');
  });

  it('records below_threshold when the derived confidence is too low', () => {
    const decision = evaluateRecordability(policy, 0.4, { amount: 250_000_00, currency: 'EUR' });
    expect(decision.disposition).toBe('below_threshold');
    expect(decision.reason).toContain('confidence');
  });

  it('records below_threshold when the value is below the value gate', () => {
    const decision = evaluateRecordability(policy, 0.9, { amount: 50_000_00, currency: 'EUR' });
    expect(decision.disposition).toBe('below_threshold');
    expect(decision.reason).toContain('value');
  });

  it('skips the value gate entirely when it is null', () => {
    const noValueGate = { minConfidence: 0.5, minValue: null };
    const decision = evaluateRecordability(noValueGate, 0.5, { amount: 1, currency: 'JPY' });
    expect(decision.disposition).toBe('converted');
  });

  it('checks currency comparability before confidence (deterministic order)', () => {
    // A low-confidence candidate in a foreign currency is a currency
    // mismatch, not a below-threshold — the gate order is fixed.
    const decision = evaluateRecordability(policy, 0.1, { amount: 1, currency: 'CHF' });
    expect(decision.disposition).toBe('currency_mismatch');
  });

  it('treats the confidence bound as inclusive', () => {
    const decision = evaluateRecordability(
      { minConfidence: 0.5, minValue: null },
      0.5,
      { amount: 1, currency: 'EUR' },
    );
    expect(decision.disposition).toBe('converted');
  });
});

// ---------------------------------------------------------------------------
// validation.ts — the conversion input
// ---------------------------------------------------------------------------

describe('validateConvertSignalsInput', () => {
  it('accepts a well-formed pass and normalizes nothing it should not', () => {
    const valid = validateConvertSignalsInput(runInput());
    expect(valid.triggerKind).toBe('scheduled');
    expect(valid.policy.minConfidence).toBe(0.5);
    expect(valid.policy.minValue).toEqual({ amount: 100_000_00, currency: 'EUR' });
    expect(valid.candidates).toHaveLength(1);
    expect(valid.candidates[0]!.evidence.observationIds).toEqual([OBS_1]);
    expect(valid.candidates[0]!.evidence.claimIds).toEqual([CLAIM_1]);
    expect(valid.actor).toEqual({ kind: 'system', id: 'cognition-worker', label: null });
  });

  it('applies the policy defaults when policy is omitted', () => {
    const valid = validateConvertSignalsInput(
      runInput({ policy: undefined, candidates: [candidate({ estimatedValue: { amount: 5, currency: 'JPY' } })] }),
    );
    expect(valid.policy.minConfidence).toBe(DEFAULT_MIN_CONFIDENCE);
    expect(valid.policy.minValue).toBeNull();
  });

  it('sorts and deduplicates the evidence id lists', () => {
    const valid = validateConvertSignalsInput(
      runInput({
        candidates: [
          candidate({ evidence: { observationIds: [OBS_2, OBS_1, OBS_2], claimIds: [CLAIM_1, CLAIM_1] } }),
        ],
      }),
    );
    expect(valid.candidates[0]!.evidence.observationIds).toEqual([OBS_1, OBS_2]);
    expect(valid.candidates[0]!.evidence.claimIds).toEqual([CLAIM_1]);
  });

  it('refuses a candidate with no evidence at all', () => {
    expectSyncCode('invalid_conversion_input', () =>
      validateConvertSignalsInput(
        runInput({ candidates: [candidate({ evidence: { observationIds: [], claimIds: [] } })] }),
      ),
    );
  });

  it('refuses an empty candidate batch (a pass is not a no-op)', () => {
    expectSyncCode('invalid_conversion_input', () =>
      validateConvertSignalsInput(runInput({ candidates: [] })),
    );
  });

  it('refuses an oversized candidate batch', () => {
    const batch = Array.from({ length: MAX_CANDIDATES_PER_RUN + 1 }, () => candidate());
    expectSyncCode('invalid_conversion_input', () =>
      validateConvertSignalsInput(runInput({ candidates: batch })),
    );
  });

  it('refuses oversized evidence lists', () => {
    const ids = Array.from(
      { length: MAX_EVIDENCE_REFS + 1 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    );
    expectSyncCode('invalid_conversion_input', () =>
      validateConvertSignalsInput(runInput({ candidates: [candidate({ evidence: { observationIds: ids } })] })),
    );
  });

  it('refuses malformed money', () => {
    expectSyncCode('invalid_conversion_input', () =>
      validateConvertSignalsInput(
        runInput({ candidates: [candidate({ estimatedValue: { amount: 1.5, currency: 'EUR' } })] }),
      ),
    );
    expectSyncCode('invalid_conversion_input', () =>
      validateConvertSignalsInput(
        runInput({ candidates: [candidate({ estimatedValue: { amount: -1, currency: 'EUR' } })] }),
      ),
    );
    expectSyncCode('invalid_conversion_input', () =>
      validateConvertSignalsInput(
        runInput({ candidates: [candidate({ estimatedValue: { amount: 5, currency: 'eur' } })] }),
      ),
    );
    expectSyncCode('invalid_conversion_input', () =>
      validateConvertSignalsInput(
        runInput({ candidates: [candidate({ estimatedValue: { amount: MAX_VALUE_AMOUNT + 1, currency: 'EUR' } })] }),
      ),
    );
  });

  it('refuses unknown input keys (audit fields are not forgeable)', () => {
    const smuggled = {
      ...runInput(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    smuggled.confidence = 0.99;
    expectSyncCode('invalid_conversion_input', () => validateConvertSignalsInput(smuggled));
    delete smuggled.confidence;
    smuggled.version = 42;
    expectSyncCode('invalid_conversion_input', () => validateConvertSignalsInput(smuggled));
  });

  it('refuses a confidence smuggled into a candidate', () => {
    const smuggled = runInput({ candidates: [candidate()] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (smuggled.candidates[0] as any).confidence = 0.99;
    expectSyncCode('invalid_conversion_input', () => validateConvertSignalsInput(smuggled));
  });

  it('refuses an untraceable actor', () => {
    expectSyncCode('invalid_conversion_input', () =>
      validateConvertSignalsInput(runInput({ actor: { kind: 'person' } })),
    );
  });

  it("requires the loop linkage for 'cognitive-execution' triggers", () => {
    expectSyncCode('invalid_conversion_input', () =>
      validateConvertSignalsInput(runInput({ trigger: { kind: 'cognitive-execution' } })),
    );
    const valid = validateConvertSignalsInput(
      runInput({ trigger: { kind: 'cognitive-execution' }, originatingExecutionId: EXECUTION_1 }),
    );
    expect(valid.originatingExecutionId).toBe(EXECUTION_1);
  });

  it('validates the policy bounds', () => {
    expectSyncCode('invalid_conversion_input', () =>
      validatePolicy({ minConfidence: 1.5 } as never, (m) => new OpportunitiesError('invalid_conversion_input', m)),
    );
    expectSyncCode('invalid_conversion_input', () =>
      validatePolicy(
        { minValue: { amount: 5 } } as never,
        (m) => new OpportunitiesError('invalid_conversion_input', m),
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// validation.ts — the revision input
// ---------------------------------------------------------------------------

describe('validateReviseOpportunityInput', () => {
  const base: ReviseOpportunityInput = {
    opportunityId: OBS_1,
    title: 'Revised title',
    actor: { kind: 'person', id: 'manager-1' },
  };

  it('accepts a content patch', () => {
    const valid = validateReviseOpportunityInput(base);
    expect(valid.title).toBe('Revised title');
    expect(valid.status).toBeNull();
    expect(valid.evidence).toBeNull();
  });

  it('accepts a surgical status transition', () => {
    const valid = validateReviseOpportunityInput({ ...base, title: undefined, status: 'pursued' });
    expect(valid.status).toBe('pursued');
    expect(valid.title).toBeNull();
  });

  it('refuses a status change mixed with content changes', () => {
    expectSyncCode('invalid_revision_input', () =>
      validateReviseOpportunityInput({ ...base, status: 'dismissed', description: 'why' }),
    );
    expectSyncCode('invalid_revision_input', () =>
      validateReviseOpportunityInput({ ...base, status: 'dismissed', evidence: { observationIds: [OBS_2] } }),
    );
  });

  it('refuses an untraceable actor and malformed ids', () => {
    expectSyncCode('invalid_revision_input', () =>
      validateReviseOpportunityInput({ ...base, actor: { kind: 'system' } }),
    );
    expectSyncCode('invalid_revision_input', () =>
      validateReviseOpportunityInput({ ...base, opportunityId: 'not-a-uuid' }),
    );
  });
});

// ---------------------------------------------------------------------------
// validation.ts — the fingerprint cap
// ---------------------------------------------------------------------------

describe('fingerprint bounds', () => {
  it('produces fingerprints within the storage cap for maximum-size evidence', () => {
    const ids = Array.from(
      { length: MAX_EVIDENCE_REFS },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    );
    const fingerprint = evidenceFingerprintOf(ids, ids);
    expect(fingerprint.length).toBeLessThanOrEqual(2048);
  });
});
