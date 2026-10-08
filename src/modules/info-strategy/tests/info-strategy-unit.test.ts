// Unit tests for the info-strategy module's PURE validation layer. No
// database, no cross-module reads.
//
// The load-bearing proofs:
//   * THE CONTEXTUAL RULE AT THE INPUT SURFACE — validation checks SHAPE
//     only; there is no rule that produces, defaults or "improves"
//     strategy content, so no caller can be handed a hardcoded
//     per-industry or per-task strategy by this module;
//   * the null-signal law for targets — an absent freshness target stays
//     null, never defaulted;
//   * every vocabulary (registries, scopes, triggers, outcome kinds) and
//     every limit enforced;
//   * an adjustment must record SOMETHING (changes and/or outcome
//     evidence) — a version that records nothing is not an adjustment.

import { describe, expect, it } from 'vitest';
import {
  validateAdjustStrategyInput,
  validateDefineStrategyInput,
  validateListStrategiesQuery,
  validateRetireStrategyInput,
} from '../validation';
import { InfoStrategyError } from '../errors';

const GOAL_ID = '0b2f8e2a-1c4b-4d8a-9f3e-7a2b6c5d4e8f';
const FINGERPRINT_ID = '1c3f8e2a-1c4b-4d8a-9f3e-7a2b6c5d4e90';
const UNKNOWN_ID = '2d4f8e2a-1c4b-4d8a-9f3e-7a2b6c5d4e91';
const STRATEGY_ID = '3e5f8e2a-1c4b-4d8a-9f3e-7a2b6c5d4e92';

const FULL_DEFINE_INPUT = {
  goalId: GOAL_ID,
  fingerprintId: FINGERPRINT_ID,
  content: {
    knowledgeRequirements: [
      {
        unknownId: UNKNOWN_ID,
        targetConfidence: 0.9,
        maxEvidenceAgeSeconds: 172_800,
        rationale: 'Safety-critical driver knowledge for a novice-heavy crew',
      },
    ],
    preferredSources: [
      {
        registry: 'source',
        ref: 'source-registry-id-1',
        rationale: 'Licensed structural engineer feed, freshest under spring conditions',
      },
    ],
    costCeilings: [
      { scope: 'per-strategy', amount: 500_000, currency: 'EUR' },
      { scope: 'per-acquisition', amount: 25_000, currency: 'EUR' },
    ],
    escalationThresholds: [
      { trigger: 'failed-attempts', afterAttempts: 2, note: 'Escalate to the senior operator' },
      { trigger: 'freshness-breach', afterAttempts: null, note: 'Re-derive the context fingerprint' },
    ],
  },
  note: 'Initial hypothesis: novice-heavy crews need fresher safety evidence',
  derivedFrom: ['coverage-snapshot:abc'],
};

describe('defineStrategy input validation (pure)', () => {
  it('validates and normalizes a full well-formed input', () => {
    const valid = validateDefineStrategyInput(FULL_DEFINE_INPUT);
    expect(valid.goalId).toBe(GOAL_ID);
    expect(valid.fingerprintId).toBe(FINGERPRINT_ID);
    expect(valid.content.knowledgeRequirements).toHaveLength(1);
    expect(valid.content.knowledgeRequirements[0]).toEqual({
      unknownId: UNKNOWN_ID,
      targetConfidence: 0.9,
      maxEvidenceAgeSeconds: 172_800,
      rationale: 'Safety-critical driver knowledge for a novice-heavy crew',
    });
    expect(valid.content.preferredSources[0]?.registry).toBe('source');
    expect(valid.content.costCeilings).toHaveLength(2);
    expect(valid.content.escalationThresholds[1]?.afterAttempts).toBeNull();
    expect(valid.note).toBe(FULL_DEFINE_INPUT.note);
    expect(valid.derivedFrom).toEqual(['coverage-snapshot:abc']);
  });

  it('applies the null-signal law to targets: absent freshness stays null, arrays default empty', () => {
    const valid = validateDefineStrategyInput({
      goalId: GOAL_ID,
      fingerprintId: FINGERPRINT_ID,
      content: {
        knowledgeRequirements: [
          { unknownId: UNKNOWN_ID, targetConfidence: 0.6, rationale: 'Nice-to-have context' },
        ],
      },
    });
    expect(valid.content.knowledgeRequirements[0]?.maxEvidenceAgeSeconds).toBeNull();
    expect(valid.content.preferredSources).toEqual([]);
    expect(valid.content.costCeilings).toEqual([]);
    expect(valid.content.escalationThresholds).toEqual([]);
    expect(valid.note).toBeNull();
    expect(valid.derivedFrom).toEqual([]);
  });

  it('requires at least one knowledge requirement (a strategy must want to know something)', () => {
    expectInvalid('invalid_strategy_input', () =>
      validateDefineStrategyInput({
        goalId: GOAL_ID,
        fingerprintId: FINGERPRINT_ID,
        content: { knowledgeRequirements: [] },
      }),
    );
  });

  it('rejects tracking the same unknown twice', () => {
    expectInvalid('invalid_strategy_input', () =>
      validateDefineStrategyInput({
        goalId: GOAL_ID,
        fingerprintId: FINGERPRINT_ID,
        content: {
          knowledgeRequirements: [
            { unknownId: UNKNOWN_ID, targetConfidence: 0.5, rationale: 'First' },
            { unknownId: UNKNOWN_ID, targetConfidence: 0.9, rationale: 'Second' },
          ],
        },
      }),
    );
  });

  it('rejects out-of-range confidence targets and malformed freshness targets', () => {
    expectInvalid('invalid_strategy_input', () =>
      validateDefineStrategyInput({
        goalId: GOAL_ID,
        fingerprintId: FINGERPRINT_ID,
        content: {
          knowledgeRequirements: [
            { unknownId: UNKNOWN_ID, targetConfidence: 0, rationale: 'Zero' },
          ],
        },
      }),
    );
    expectInvalid('invalid_strategy_input', () =>
      validateDefineStrategyInput({
        goalId: GOAL_ID,
        fingerprintId: FINGERPRINT_ID,
        content: {
          knowledgeRequirements: [
            { unknownId: UNKNOWN_ID, targetConfidence: 1.5, rationale: 'Too sure' },
          ],
        },
      }),
    );
    expectInvalid('invalid_strategy_input', () =>
      validateDefineStrategyInput({
        goalId: GOAL_ID,
        fingerprintId: FINGERPRINT_ID,
        content: {
          knowledgeRequirements: [
            { unknownId: UNKNOWN_ID, targetConfidence: 0.5, maxEvidenceAgeSeconds: 0, rationale: 'Instant' },
          ],
        },
      }),
    );
  });

  it('rejects malformed ids, registries, currencies and ceilings', () => {
    expectInvalid('invalid_strategy_input', () =>
      validateDefineStrategyInput({
        goalId: 'not-a-uuid',
        fingerprintId: FINGERPRINT_ID,
        content: { knowledgeRequirements: [{ unknownId: UNKNOWN_ID, targetConfidence: 0.5, rationale: 'R' }] },
      }),
    );
    expectInvalid('invalid_strategy_input', () =>
      validateDefineStrategyInput({
        goalId: GOAL_ID,
        fingerprintId: 'not-a-uuid',
        content: { knowledgeRequirements: [{ unknownId: UNKNOWN_ID, targetConfidence: 0.5, rationale: 'R' }] },
      }),
    );
    expectInvalid('invalid_strategy_input', () =>
      validateDefineStrategyInput({
        goalId: GOAL_ID,
        fingerprintId: FINGERPRINT_ID,
        content: {
          knowledgeRequirements: [{ unknownId: UNKNOWN_ID, targetConfidence: 0.5, rationale: 'R' }],
          preferredSources: [{ registry: 'cron', ref: 'x', rationale: 'R' }],
        },
      }),
    );
    expectInvalid('invalid_strategy_input', () =>
      validateDefineStrategyInput({
        goalId: GOAL_ID,
        fingerprintId: FINGERPRINT_ID,
        content: {
          knowledgeRequirements: [{ unknownId: UNKNOWN_ID, targetConfidence: 0.5, rationale: 'R' }],
          costCeilings: [{ scope: 'per-strategy', amount: 100, currency: 'euros' }],
        },
      }),
    );
    expectInvalid('invalid_strategy_input', () =>
      validateDefineStrategyInput({
        goalId: GOAL_ID,
        fingerprintId: FINGERPRINT_ID,
        content: {
          knowledgeRequirements: [{ unknownId: UNKNOWN_ID, targetConfidence: 0.5, rationale: 'R' }],
          costCeilings: [
            { scope: 'per-strategy', amount: 100, currency: 'EUR' },
            { scope: 'per-strategy', amount: 200, currency: 'EUR' },
          ],
        },
      }),
    );
  });

  it('rejects malformed escalation thresholds (attempts coupling and duplicates)', () => {
    expectInvalid('invalid_strategy_input', () =>
      validateDefineStrategyInput({
        goalId: GOAL_ID,
        fingerprintId: FINGERPRINT_ID,
        content: {
          knowledgeRequirements: [{ unknownId: UNKNOWN_ID, targetConfidence: 0.5, rationale: 'R' }],
          escalationThresholds: [{ trigger: 'failed-attempts', note: 'No attempt count' }],
        },
      }),
    );
    expectInvalid('invalid_strategy_input', () =>
      validateDefineStrategyInput({
        goalId: GOAL_ID,
        fingerprintId: FINGERPRINT_ID,
        content: {
          knowledgeRequirements: [{ unknownId: UNKNOWN_ID, targetConfidence: 0.5, rationale: 'R' }],
          escalationThresholds: [{ trigger: 'budget-exhausted', afterAttempts: 3, note: 'Attempts on a budget trigger' }],
        },
      }),
    );
    expectInvalid('invalid_strategy_input', () =>
      validateDefineStrategyInput({
        goalId: GOAL_ID,
        fingerprintId: FINGERPRINT_ID,
        content: {
          knowledgeRequirements: [{ unknownId: UNKNOWN_ID, targetConfidence: 0.5, rationale: 'R' }],
          escalationThresholds: [
            { trigger: 'confidence-shortfall', note: 'One' },
            { trigger: 'confidence-shortfall', note: 'Two' },
          ],
        },
      }),
    );
  });
});

describe('adjustStrategy input validation (pure)', () => {
  it('validates a full adjustment with changes and outcome evidence', () => {
    const valid = validateAdjustStrategyInput({
      strategyId: STRATEGY_ID,
      changes: {
        preferredSources: [{ registry: 'channel', ref: 'channel-1', rationale: 'Field crew radio reports' }],
      },
      outcomeEvidence: [
        {
          kind: 'mission',
          ref: 'mission-id-1',
          observed: 'The 48h freshness target was unachievable; 7-day evidence sufficed for the decision',
        },
      ],
      note: 'Relax freshness after the fall mission outcomes',
      derivedFrom: ['mission:mission-id-1'],
    });
    expect(valid.strategyId).toBe(STRATEGY_ID);
    expect(valid.changes?.preferredSources).toHaveLength(1);
    expect(valid.changes?.knowledgeRequirements).toBeUndefined();
    expect(valid.outcomeEvidence[0]?.kind).toBe('mission');
    expect(valid.note).toBe('Relax freshness after the fall mission outcomes');
  });

  it('rejects an adjustment that records nothing (no changes, no evidence)', () => {
    expectInvalid('invalid_adjustment_input', () =>
      validateAdjustStrategyInput({ strategyId: STRATEGY_ID, note: 'Nothing changed' }),
    );
  });

  it('rejects a missing note (every version is auditable)', () => {
    expectInvalid('invalid_adjustment_input', () =>
      validateAdjustStrategyInput({
        strategyId: STRATEGY_ID,
        outcomeEvidence: [{ kind: 'other', ref: 'ref-1', observed: 'Something' }],
      }),
    );
  });

  it('rejects malformed outcome evidence kinds and refs', () => {
    expectInvalid('invalid_adjustment_input', () =>
      validateAdjustStrategyInput({
        strategyId: STRATEGY_ID,
        outcomeEvidence: [{ kind: 'vibe', ref: 'ref-1', observed: 'Felt right' }],
        note: 'N',
      }),
    );
    expectInvalid('invalid_adjustment_input', () =>
      validateAdjustStrategyInput({
        strategyId: STRATEGY_ID,
        outcomeEvidence: [{ kind: 'mission', ref: '', observed: 'Empty ref' }],
        note: 'N',
      }),
    );
  });

  it('allows an outcome-evidence-only adjustment (the learning loop needs no content change)', () => {
    const valid = validateAdjustStrategyInput({
      strategyId: STRATEGY_ID,
      outcomeEvidence: [
        { kind: 'acquisition-plan', ref: 'plan-9', observed: 'Cost ceiling hit without confidence gain' },
      ],
      note: 'Recorded for the next strategy decision',
    });
    expect(valid.changes).toBeNull();
    expect(valid.outcomeEvidence).toHaveLength(1);
  });
});

describe('retire + query validation (pure)', () => {
  it('requires a uuid and a non-empty reason on retire', () => {
    const valid = validateRetireStrategyInput({ strategyId: STRATEGY_ID, reason: 'Goal direction changed' });
    expect(valid.reason).toBe('Goal direction changed');
    expectInvalid('invalid_strategy_input', () =>
      validateRetireStrategyInput({ strategyId: 'nope', reason: 'R' }),
    );
    expectInvalid('invalid_strategy_input', () =>
      validateRetireStrategyInput({ strategyId: STRATEGY_ID, reason: '   ' }),
    );
  });

  it('validates list query shapes and limits', () => {
    expect(validateListStrategiesQuery()).toEqual({
      goalId: null,
      fingerprintId: null,
      status: null,
      limit: 100,
    });
    expect(validateListStrategiesQuery({ goalId: GOAL_ID, status: 'retired', limit: 5 })).toEqual({
      goalId: GOAL_ID,
      fingerprintId: null,
      status: 'retired',
      limit: 5,
    });
    expectInvalid('invalid_query', () => validateListStrategiesQuery({ limit: 0 }));
    expectInvalid('invalid_query', () => validateListStrategiesQuery({ status: 'draft' }));
    expectInvalid('invalid_query', () => validateListStrategiesQuery({ goalId: 'nope' }));
  });
});

function expectInvalid(code: string, fn: () => unknown): InfoStrategyError {
  try {
    fn();
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(InfoStrategyError);
    const typed = error as InfoStrategyError;
    expect(typed.code).toBe(code);
    return typed;
  }
}
