// Unit tests for the missions module's pure validation/normalization logic
// (no database). Covers every guard a caller crosses before storage:
//
//  * tenant-context shape (invalid_context);
//  * create-input validation — required/bounded strings, vocabularies
//    (urgency, candidate kinds), affected-goal refs (uuid + unique +
//    capped), unknown refs (uuid, deduplicated, sorted, capped),
//    confidences ([0,1] with the gap rule target > current), information
//    value, budgets (integer minor units + ISO currency), reward terms,
//    candidates (traceable), defaults, and unknown-key rejection including
//    the system-minted fields (id, tenantId, version, status, changeKind,
//    completion, recordedAt, changedByPrincipal);
//  * revision-patch validation — at-least-one-change, tri-state
//    rewardTerms, NO status in a revision (lifecycle transitions are
//    dedicated operations), remapped error codes;
//  * completion/abandonment input validation (terminal transitions
//    require their structured why);
//  * list/version/history query validation.
//
// The epistemics-contract existence check for unknownIds is a service-level
// concern (it needs the db) and is covered by the service tests.

import { describe, expect, it } from 'vitest';
import { MissionsError } from '../errors';
import type { AbandonMissionInput, CompleteMissionInput, CreateMissionInput, ReviseMissionInput } from '../types';
import {
  assertMissionTenantContext,
  escapeLike,
  isMissionCandidateKind,
  isMissionChangeKind,
  isMissionPartyKind,
  isMissionStatus,
  isMissionUrgency,
  isUuid,
  MISSION_CANDIDATE_KINDS,
  validateAbandonMissionInput,
  validateCompleteMissionInput,
  validateCreateMissionInput,
  validateHistoryQuery,
  validateListMissionsQuery,
  validateReviseMissionInput,
  validateVersionQuery,
} from '../validation';

const PERSON_ID = '0b2f8e2a-1c4b-4d8a-9f3e-7a2b6c5d4e8f';
const GOAL_ID = '1c3a9f4b-2d5c-4e9b-8a4f-8b3c7d6e5f9a';
const UNKNOWN_ID = '3e5c1b6d-4f7e-4a0b-8c6a-0d1e2f3a4b5c';
const UNKNOWN_ID_2 = '4f6d2c7e-5a8f-4b1c-9d7b-1e2f3a4b5c6d';

/** A full W011 definition, parameterized for the suites below. */
function missionInput(overrides: Partial<CreateMissionInput> = {}): CreateMissionInput {
  return {
    title: 'Churn root cause',
    knowledgeObjective: 'Why did churn rise in Q3 and what is the dominant driver?',
    affectedGoals: [{ goalId: GOAL_ID, label: 'Q4 churn reduction' }],
    unknownIds: [UNKNOWN_ID],
    informationValue: 0.8,
    urgency: 'high',
    currentConfidence: 0.1,
    targetConfidence: 0.85,
    investigationBudget: { amount: 250_00, currency: 'EUR' },
    rewardBudget: { amount: 50_00, currency: 'EUR' },
    rewardTerms: 'A validated root-cause contribution earns a bonus.',
    candidateSources: [
      { kind: 'person', id: PERSON_ID, label: 'VP Customer Success' },
      { kind: 'system', label: 'billing-export' },
    ],
    completionCriteria: 'A validated root-cause explanation with confidence >= 0.85.',
    actor: { kind: 'person', id: PERSON_ID },
    rationale: 'goal-gap-2026-09',
    ...overrides,
  };
}

function expectCode(code: string, fn: () => unknown): void {
  try {
    fn();
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(MissionsError);
    expect((error as MissionsError).code).toBe(code);
  }
}

// ---------------------------------------------------------------------------
// Tenant context
// ---------------------------------------------------------------------------

describe('assertMissionTenantContext', () => {
  it('accepts a well-formed context', () => {
    expect(() =>
      assertMissionTenantContext({
        tenantId: 't',
        principalId: 'p',
        authority: ['x'],
      }),
    ).not.toThrow();
  });

  it('rejects blank tenant/principal and non-array authority', () => {
    expectCode('invalid_context', () =>
      assertMissionTenantContext({ tenantId: ' ', principalId: 'p', authority: [] }),
    );
    expectCode('invalid_context', () =>
      assertMissionTenantContext({ tenantId: 't', principalId: '', authority: [] }),
    );
    expectCode('invalid_context', () =>
      assertMissionTenantContext({ tenantId: 't', principalId: 'p', authority: 'none' as unknown as string[] }),
    );
  });
});

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

describe('type guards and helpers', () => {
  it('guards every vocabulary', () => {
    for (const urgency of ['critical', 'high', 'medium', 'low'] as const) {
      expect(isMissionUrgency(urgency)).toBe(true);
    }
    expect(isMissionUrgency('urgent')).toBe(false);
    for (const status of ['active', 'completed', 'abandoned'] as const) {
      expect(isMissionStatus(status)).toBe(true);
    }
    expect(isMissionStatus('archived')).toBe(false);
    for (const kind of ['created', 'revised', 'completed', 'abandoned'] as const) {
      expect(isMissionChangeKind(kind)).toBe(true);
    }
    expect(isMissionChangeKind('reactivated')).toBe(false);
    for (const kind of ['person', 'team', 'agent', 'system', 'external'] as const) {
      expect(isMissionPartyKind(kind)).toBe(true);
    }
    expect(isMissionPartyKind('manager')).toBe(false);
    expect(MISSION_CANDIDATE_KINDS).toEqual([
      'person',
      'system',
      'document',
      'external',
      'agent',
      'analysis',
    ]);
    for (const kind of MISSION_CANDIDATE_KINDS) {
      expect(isMissionCandidateKind(kind)).toBe(true);
    }
    expect(isMissionCandidateKind('database')).toBe(false);
  });

  it('guards uuid shape and escapes LIKE metacharacters', () => {
    expect(isUuid(GOAL_ID)).toBe(true);
    expect(isUuid('not-a-uuid')).toBe(false);
    expect(escapeLike('50% of _all\\')).toBe('50\\% of \\_all\\\\');
  });
});

// ---------------------------------------------------------------------------
// Create input
// ---------------------------------------------------------------------------

describe('validateCreateMissionInput', () => {
  it('normalizes a full W011 definition', () => {
    const valid = validateCreateMissionInput(missionInput());
    expect(valid.content).toEqual({
      title: 'Churn root cause',
      knowledgeObjective: 'Why did churn rise in Q3 and what is the dominant driver?',
      affectedGoals: [{ goalId: GOAL_ID, label: 'Q4 churn reduction' }],
      unknownIds: [UNKNOWN_ID],
      informationValue: 0.8,
      urgency: 'high',
      currentConfidence: 0.1,
      targetConfidence: 0.85,
      investigationBudget: { amount: 250_00, currency: 'EUR' },
      rewardBudget: { amount: 50_00, currency: 'EUR' },
      rewardTerms: 'A validated root-cause contribution earns a bonus.',
      candidateSources: [
        { kind: 'person', id: PERSON_ID, label: 'VP Customer Success' },
        { kind: 'system', id: null, label: 'billing-export' },
      ],
      completionCriteria: 'A validated root-cause explanation with confidence >= 0.85.',
    });
    expect(valid.actor).toEqual({ kind: 'person', id: PERSON_ID, label: null });
    expect(valid.rationale).toBe('goal-gap-2026-09');
  });

  it('applies the empty defaults (affected goals, unknowns, candidates, reward terms; current confidence 0)', () => {
    const input = missionInput();
    delete input.affectedGoals;
    delete input.unknownIds;
    delete input.candidateSources;
    delete input.rewardTerms;
    delete input.currentConfidence;
    delete input.rationale;
    const valid = validateCreateMissionInput(input);
    expect(valid.content.affectedGoals).toEqual([]);
    expect(valid.content.unknownIds).toEqual([]);
    expect(valid.content.candidateSources).toEqual([]);
    expect(valid.content.rewardTerms).toBeNull();
    expect(valid.content.currentConfidence).toBe(0);
    expect(valid.rationale).toBeNull();
  });

  it('rejects non-object input and unknown keys, including system-minted fields', () => {
    expectCode('invalid_mission_input', () => validateCreateMissionInput(null as unknown as CreateMissionInput));
    expectCode('invalid_mission_input', () => validateCreateMissionInput('x' as unknown as CreateMissionInput));
    for (const smuggled of [
      'id',
      'tenantId',
      'version',
      'status',
      'changeKind',
      'completion',
      'recordedAt',
      'changedByPrincipal',
    ]) {
      expectCode(
        'invalid_mission_input',
        () => validateCreateMissionInput({ ...missionInput(), [smuggled]: 'x' } as unknown as CreateMissionInput),
      );
    }
  });

  it('requires and bounds the text fields', () => {
    expectCode('invalid_mission_input', () =>
      validateCreateMissionInput(missionInput({ title: '  ' })),
    );
    expectCode('invalid_mission_input', () =>
      validateCreateMissionInput(missionInput({ title: 'x'.repeat(201) })),
    );
    expectCode('invalid_mission_input', () =>
      validateCreateMissionInput(missionInput({ knowledgeObjective: '' })),
    );
    expectCode('invalid_mission_input', () =>
      validateCreateMissionInput(missionInput({ knowledgeObjective: 'x'.repeat(2001) })),
    );
    expectCode('invalid_mission_input', () =>
      validateCreateMissionInput(missionInput({ completionCriteria: '  ' })),
    );
    expectCode('invalid_mission_input', () =>
      validateCreateMissionInput(missionInput({ completionCriteria: 'x'.repeat(4001) })),
    );
    expectCode('invalid_mission_input', () =>
      validateCreateMissionInput(missionInput({ rewardTerms: 'x'.repeat(2001) })),
    );
  });

  it('validates the urgency vocabulary', () => {
    expectCode('invalid_mission_input', () =>
      validateCreateMissionInput(missionInput({ urgency: 'whenever' as CreateMissionInput['urgency'] })),
    );
  });

  it('validates affected-goal refs (uuid, unknown keys, uniqueness, cap)', () => {
    expectCode('invalid_mission_input', () =>
      validateCreateMissionInput(missionInput({ affectedGoals: [{ goalId: 'not-a-uuid' }] })),
    );
    expectCode('invalid_mission_input', () =>
      validateCreateMissionInput(
        missionInput({
          affectedGoals: [{ goalId: GOAL_ID, note: 'why' }] as unknown as CreateMissionInput['affectedGoals'],
        }),
      ),
    );
    expectCode('invalid_mission_input', () =>
      validateCreateMissionInput(
        missionInput({ affectedGoals: [{ goalId: GOAL_ID }, { goalId: GOAL_ID }] }),
      ),
    );
    expectCode('invalid_mission_input', () =>
      validateCreateMissionInput({
        ...missionInput(),
        affectedGoals: Array.from({ length: 17 }, (_, i) => ({
          goalId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
        })),
      }),
    );
  });

  it('normalizes unknown refs (uuid, deduplicated, sorted) and caps them', () => {
    const valid = validateCreateMissionInput(
      missionInput({ unknownIds: [UNKNOWN_ID_2, UNKNOWN_ID, UNKNOWN_ID_2.toUpperCase()] }),
    );
    expect(valid.content.unknownIds).toEqual([UNKNOWN_ID, UNKNOWN_ID_2]);
    expectCode('invalid_mission_input', () =>
      validateCreateMissionInput(missionInput({ unknownIds: ['nope'] })),
    );
    expectCode('invalid_mission_input', () =>
      validateCreateMissionInput({
        ...missionInput(),
        unknownIds: Array.from({ length: 17 }, () => UNKNOWN_ID),
      }),
    );
  });

  it('bounds information value and confidences to [0, 1]', () => {
    expectCode('invalid_mission_input', () =>
      validateCreateMissionInput(missionInput({ informationValue: 1.01 })),
    );
    expectCode('invalid_mission_input', () =>
      validateCreateMissionInput(missionInput({ informationValue: -0.1 })),
    );
    expectCode('invalid_mission_input', () =>
      validateCreateMissionInput(missionInput({ currentConfidence: 1.5 })),
    );
    expectCode('invalid_mission_input', () =>
      validateCreateMissionInput(missionInput({ targetConfidence: Number.NaN })),
    );
  });

  it('enforces the confidence gap rule (target > current)', () => {
    expectCode('invalid_mission_input', () =>
      validateCreateMissionInput(missionInput({ currentConfidence: 0.85, targetConfidence: 0.85 })),
    );
    expectCode('invalid_mission_input', () =>
      validateCreateMissionInput(missionInput({ currentConfidence: 0.9, targetConfidence: 0.85 })),
    );
    expect(validateCreateMissionInput(missionInput({ currentConfidence: 0.84, targetConfidence: 0.85 })).content.targetConfidence).toBe(0.85);
  });

  it('validates budgets (integer minor units, non-negative, safe range, ISO currency)', () => {
    const budgetError = (overrides: Partial<{ amount: number; currency: string }>): void => {
      expectCode('invalid_mission_input', () =>
        validateCreateMissionInput(missionInput({ investigationBudget: { amount: 10, currency: 'EUR', ...overrides } })),
      );
    };
    budgetError({ amount: 10.5 });
    budgetError({ amount: -1 });
    budgetError({ amount: 9_007_199_254_740_992 });
    budgetError({ currency: 'eur' });
    budgetError({ currency: 'EURO' });
    budgetError({ currency: 'E1' });
    expectCode('invalid_mission_input', () =>
      validateCreateMissionInput(missionInput({ rewardBudget: { amount: 1, currency: 'usd' } })),
    );
    // unknown keys inside a budget object
    expectCode('invalid_mission_input', () =>
      validateCreateMissionInput(
        missionInput({
          rewardBudget: { amount: 1, currency: 'EUR', cap: 5 } as CreateMissionInput['rewardBudget'],
        }),
      ),
    );
    // zero budgets are legal: nothing may be spent / offered
    const zeroed = validateCreateMissionInput(
      missionInput({
        investigationBudget: { amount: 0, currency: 'EUR' },
        rewardBudget: { amount: 0, currency: 'USD' },
      }),
    );
    expect(zeroed.content.investigationBudget).toEqual({ amount: 0, currency: 'EUR' });
    expect(zeroed.content.rewardBudget).toEqual({ amount: 0, currency: 'USD' });
  });

  it('validates candidate sources (kind vocabulary, traceability, cap)', () => {
    expectCode('invalid_mission_input', () =>
      validateCreateMissionInput(missionInput({ candidateSources: [{ kind: 'database' }] as unknown as CreateMissionInput['candidateSources'] })),
    );
    expectCode('invalid_mission_input', () =>
      validateCreateMissionInput(missionInput({ candidateSources: [{ kind: 'person' }] as CreateMissionInput['candidateSources'] })),
    );
    expectCode('invalid_mission_input', () =>
      validateCreateMissionInput(
        missionInput({
          candidateSources: Array.from({ length: 17 }, () => ({ kind: 'system', label: 's' })),
        }),
      ),
    );
    // label-only candidates are traceable and keep their kind
    const valid = validateCreateMissionInput(
      missionInput({ candidateSources: [{ kind: 'analysis', label: 'cohort churn model' }] }),
    );
    expect(valid.content.candidateSources).toEqual([
      { kind: 'analysis', id: null, label: 'cohort churn model' },
    ]);
  });

  it('validates the actor party (traceable, kind vocabulary)', () => {
    expectCode('invalid_mission_input', () =>
      validateCreateMissionInput(missionInput({ actor: { kind: 'manager' } as unknown as CreateMissionInput['actor'] })),
    );
    expectCode('invalid_mission_input', () =>
      validateCreateMissionInput(missionInput({ actor: { kind: 'person' } as CreateMissionInput['actor'] })),
    );
    const valid = validateCreateMissionInput(missionInput({ actor: { kind: 'system', label: 'cognition' } }));
    expect(valid.actor).toEqual({ kind: 'system', id: null, label: 'cognition' });
  });
});

// ---------------------------------------------------------------------------
// Revision input
// ---------------------------------------------------------------------------

describe('validateReviseMissionInput', () => {
  it('validates patch shapes and records which fields changed', () => {
    const valid = validateReviseMissionInput({
      missionId: GOAL_ID,
      title: 'Churn root cause (refined)',
      investigationBudget: { amount: 500_00, currency: 'EUR' },
      actor: { kind: 'person', id: PERSON_ID },
      rationale: 'budget raised',
    });
    expect(valid.missionId).toBe(GOAL_ID);
    expect(valid.patch.title).toBe('Churn root cause (refined)');
    expect(valid.patch.investigationBudget).toEqual({ amount: 500_00, currency: 'EUR' });
    expect(valid.patch.unknownIds).toBeUndefined();
    expect(valid.rationale).toBe('budget raised');
  });

  it('requires at least one changed field', () => {
    expectCode('invalid_revision_input', () =>
      validateReviseMissionInput({ missionId: GOAL_ID, actor: { kind: 'person', id: PERSON_ID } }),
    );
  });

  it('rejects status — lifecycle transitions are dedicated operations, never revisions', () => {
    expectCode(
      'invalid_revision_input',
      () =>
        validateReviseMissionInput({
          missionId: GOAL_ID,
          status: 'completed',
          actor: { kind: 'person', id: PERSON_ID },
        } as unknown as ReviseMissionInput),
    );
    expectCode(
      'invalid_revision_input',
      () =>
        validateReviseMissionInput({
          missionId: GOAL_ID,
          completion: { achievedConfidence: 0.9, outcome: 'done' },
          actor: { kind: 'person', id: PERSON_ID },
        } as unknown as ReviseMissionInput),
    );
  });

  it('treats rewardTerms as tri-state (null clears, string sets)', () => {
    const cleared = validateReviseMissionInput({
      missionId: GOAL_ID,
      rewardTerms: null,
      actor: { kind: 'person', id: PERSON_ID },
    });
    expect(cleared.patch.rewardTerms).toBeNull();
    const set = validateReviseMissionInput({
      missionId: GOAL_ID,
      rewardTerms: '  doubled bonus  ',
      actor: { kind: 'person', id: PERSON_ID },
    });
    expect(set.patch.rewardTerms).toBe('doubled bonus');
    expectCode('invalid_revision_input', () =>
      validateReviseMissionInput({
        missionId: GOAL_ID,
        rewardTerms: 'x'.repeat(2001),
        actor: { kind: 'person', id: PERSON_ID },
      }),
    );
  });

  it('remaps field-guard errors to invalid_revision_input and validates mission id + patch values', () => {
    expectCode('invalid_revision_input', () =>
      validateReviseMissionInput({ missionId: 'nope', title: 'x', actor: { kind: 'person', id: PERSON_ID } }),
    );
    expectCode('invalid_revision_input', () =>
      validateReviseMissionInput({
        missionId: GOAL_ID,
        urgency: 'later' as CreateMissionInput['urgency'],
        actor: { kind: 'person', id: PERSON_ID },
      }),
    );
    expectCode('invalid_revision_input', () =>
      validateReviseMissionInput({
        missionId: GOAL_ID,
        targetConfidence: 2,
        actor: { kind: 'person', id: PERSON_ID },
      }),
    );
    expectCode('invalid_revision_input', () =>
      validateReviseMissionInput({
        missionId: GOAL_ID,
        unknownIds: ['nope'],
        actor: { kind: 'person', id: PERSON_ID },
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Completion / abandonment inputs
// ---------------------------------------------------------------------------

describe('validateCompleteMissionInput', () => {
  const input: CompleteMissionInput = {
    missionId: GOAL_ID,
    achievedConfidence: 0.9,
    outcome: 'Pricing-driven churn concentrated in the SME segment.',
    actor: { kind: 'person', id: PERSON_ID },
  };

  it('accepts a well-formed completion', () => {
    const valid = validateCompleteMissionInput(input);
    expect(valid).toEqual({
      missionId: GOAL_ID,
      achievedConfidence: 0.9,
      outcome: 'Pricing-driven churn concentrated in the SME segment.',
      actor: { kind: 'person', id: PERSON_ID, label: null },
    });
  });

  it('bounds achievedConfidence to [0, 1] and requires the outcome', () => {
    expectCode('invalid_completion_input', () =>
      validateCompleteMissionInput({ ...input, achievedConfidence: 1.2 }),
    );
    expectCode('invalid_completion_input', () =>
      validateCompleteMissionInput({ ...input, achievedConfidence: -0.1 }),
    );
    expectCode('invalid_completion_input', () => validateCompleteMissionInput({ ...input, outcome: ' ' }));
    expectCode('invalid_completion_input', () =>
      validateCompleteMissionInput({ ...input, outcome: 'x'.repeat(4001) }),
    );
    expectCode('invalid_completion_input', () =>
      validateCompleteMissionInput({ ...input, missionId: 'nope' }),
    );
    expectCode('invalid_completion_input', () =>
      validateCompleteMissionInput({ ...input, status: 'completed' } as unknown as CompleteMissionInput),
    );
  });
});

describe('validateAbandonMissionInput', () => {
  const input: AbandonMissionInput = { missionId: GOAL_ID, reason: 'goal archived', actor: { kind: 'person', id: PERSON_ID } };

  it('accepts a well-formed abandonment and requires its reason', () => {
    const valid = validateAbandonMissionInput(input);
    expect(valid.reason).toBe('goal archived');
    expect(valid.actor).toEqual({ kind: 'person', id: PERSON_ID, label: null });
    expectCode('invalid_abandonment_input', () =>
      validateAbandonMissionInput({ ...input, reason: '  ' }),
    );
    expectCode('invalid_abandonment_input', () =>
      validateAbandonMissionInput({ ...input, reason: 'x'.repeat(2001) }),
    );
    expectCode('invalid_abandonment_input', () =>
      validateAbandonMissionInput({ ...input, missionId: 'nope' }),
    );
    expectCode('invalid_abandonment_input', () =>
      validateAbandonMissionInput({ ...input, rationale: 'extra' } as unknown as AbandonMissionInput),
    );
  });
});

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

describe('validateListMissionsQuery', () => {
  it('normalizes the empty query to defaults', () => {
    expect(validateListMissionsQuery({})).toEqual({
      status: null,
      urgency: null,
      affectedGoalId: null,
      unknownId: null,
      candidateKind: null,
      candidateId: null,
      search: null,
      limit: 50,
    });
  });

  it('validates enums, uuids, candidate pairing and the limit', () => {
    expectCode('invalid_query', () =>
      validateListMissionsQuery({ status: 'paused' as never }),
    );
    expectCode('invalid_query', () =>
      validateListMissionsQuery({ urgency: 'later' as never }),
    );
    expectCode('invalid_query', () => validateListMissionsQuery({ affectedGoalId: 'nope' }));
    expectCode('invalid_query', () => validateListMissionsQuery({ unknownId: 'nope' }));
    expectCode('invalid_query', () =>
      validateListMissionsQuery({ candidateKind: 'database' as never }),
    );
    expectCode('invalid_query', () =>
      validateListMissionsQuery({ candidateId: PERSON_ID }), // requires candidateKind
    );
    expectCode('invalid_query', () => validateListMissionsQuery({ limit: 0 }));
    expectCode('invalid_query', () => validateListMissionsQuery({ limit: 501 }));
    expectCode('invalid_query', () => validateListMissionsQuery({ limit: 1.5 }));
    expectCode('invalid_query', () => validateListMissionsQuery({ nope: 1 } as never));
    // candidate kind alone is legal; kind + id pairs
    expect(validateListMissionsQuery({ candidateKind: 'person' }).candidateKind).toBe('person');
    expect(
      validateListMissionsQuery({ candidateKind: 'person', candidateId: PERSON_ID }).candidateId,
    ).toBe(PERSON_ID);
  });
});

describe('validateVersionQuery / validateHistoryQuery', () => {
  it('validates mission id shape and version number', () => {
    expect(validateVersionQuery({ missionId: GOAL_ID, version: 3 })).toEqual({
      missionId: GOAL_ID,
      version: 3,
    });
    expectCode('invalid_query', () => validateVersionQuery({ missionId: 'nope', version: 1 }));
    expectCode('invalid_query', () => validateVersionQuery({ missionId: GOAL_ID, version: 0 }));
    expectCode('invalid_query', () => validateVersionQuery({ missionId: GOAL_ID, version: 1.5 }));
    expectCode('invalid_query', () => validateVersionQuery({ missionId: GOAL_ID, version: 1, extra: 1 } as never));
  });

  it('validates the history query', () => {
    expect(validateHistoryQuery({ missionId: GOAL_ID })).toEqual({ missionId: GOAL_ID });
    expectCode('invalid_query', () => validateHistoryQuery({ missionId: 'nope' }));
    expectCode('invalid_query', () => validateHistoryQuery({ missionId: GOAL_ID, extra: 1 } as never));
  });
});
