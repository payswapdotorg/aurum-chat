// Unit tests for the MCP argument normalizers (W039) — pure, no database.
// The normalizers are the client-facing validation boundary of every tool;
// these tests pin the shape rules (types, enums, uuids, bounds, unknown-key
// rejection, the gated tools' reserved arguments).

import { describe, expect, it } from 'vitest';
import { McpToolError } from '../errors';
import { epistemicsTools } from '../tools/epistemics';
import { goalsTools } from '../tools/goals';
import { missionsTools } from '../tools/missions';
import { observationsTools } from '../tools/observations';
import {
  optionalIdempotencyKey,
  requireArgsObject,
  requireEnum,
  requireUuid,
  rejectUnknownKeys,
} from '../validation';

const listGoals = goalsTools.find((tool) => tool.name === 'list_goals')!;
const getGoal = goalsTools.find((tool) => tool.name === 'get_goal')!;
const requestInvestigation = missionsTools.find((tool) => tool.name === 'request_investigation')!;
const listUnknowns = epistemicsTools.find((tool) => tool.name === 'list_unknowns')!;
const getBelief = epistemicsTools.find((tool) => tool.name === 'get_belief')!;
const listObservations = observationsTools.find((tool) => tool.name === 'list_observations')!;

function expectInvalidArguments(fn: () => unknown): McpToolError {
  try {
    fn();
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(McpToolError);
    const toolError = error as McpToolError;
    expect(toolError.code).toBe('invalid_arguments');
    return toolError;
  }
}

const GOAL_ID = '0b2f8e2a-1c4b-4d8a-9f3e-7a2b6c5d4e8f';

describe('validation helpers', () => {
  it('requireArgsObject rejects non-objects', () => {
    for (const bad of [null, undefined, 'x', 42, [], true]) {
      expectInvalidArguments(() => requireArgsObject(bad, 't'));
    }
  });

  it('rejectUnknownKeys names the smuggled key', () => {
    const error = expectInvalidArguments(() =>
      rejectUnknownKeys({ extra: 1 }, ['allowed'] as const, 'mytool'),
    );
    expect(error.message).toContain("'mytool' does not accept argument 'extra'");
  });

  it('requireUuid enforces uuid shape', () => {
    expect(requireUuid({ goalId: GOAL_ID }, 'goalId', 't')).toBe(GOAL_ID);
    expectInvalidArguments(() => requireUuid({ goalId: 'nope' }, 'goalId', 't'));
  });

  it('requireEnum enforces the closed vocabulary', () => {
    expect(requireEnum({ s: 'open' }, 's', ['open', 'resolved'] as const, 't')).toBe('open');
    expectInvalidArguments(() => requireEnum({ s: 'bogus' }, 's', ['open'] as const, 't'));
  });

  it('optionalIdempotencyKey enforces the actions-module pattern', () => {
    expect(optionalIdempotencyKey({ idempotencyKey: 'mission:q4-001' }, 't')).toBe('mission:q4-001');
    expect(optionalIdempotencyKey({}, 't')).toBeNull();
    expectInvalidArguments(() => optionalIdempotencyKey({ idempotencyKey: 'has space' }, 't'));
    expectInvalidArguments(() => optionalIdempotencyKey({ idempotencyKey: '#hash' }, 't'));
  });
});

describe('list_goals normalization', () => {
  it('passes valid filters through', () => {
    const args = listGoals.normalize({
      status: 'active',
      priority: 'critical',
      ownerKind: 'person',
      ownerId: GOAL_ID,
      search: 'churn',
      limit: 10,
    });
    expect(args).toEqual({
      status: 'active',
      priority: 'critical',
      ownerKind: 'person',
      ownerId: GOAL_ID,
      search: 'churn',
      limit: 10,
    });
  });

  it('normalizes absent/blank filters to an empty query', () => {
    expect(listGoals.normalize({})).toEqual({});
    expect(listGoals.normalize({ search: '   ' })).toEqual({});
  });

  it('rejects a bad status/priority and an out-of-bounds limit', () => {
    expectInvalidArguments(() => listGoals.normalize({ status: 'paused' }));
    expectInvalidArguments(() => listGoals.normalize({ priority: 'urgent' }));
    expectInvalidArguments(() => listGoals.normalize({ limit: 0 }));
    expectInvalidArguments(() => listGoals.normalize({ limit: 501 }));
    expectInvalidArguments(() => listGoals.normalize({ limit: 'ten' }));
  });
});

describe('get_goal / get_belief normalization', () => {
  it('requires a uuid id', () => {
    expect(getGoal.normalize({ goalId: GOAL_ID })).toEqual({ goalId: GOAL_ID });
    expectInvalidArguments(() => getGoal.normalize({}));
    expectInvalidArguments(() => getGoal.normalize({ goalId: 'x' }));
  });

  it('get_belief accepts an asOf instant and rejects unknown keys', () => {
    expect(getBelief.normalize({ beliefId: GOAL_ID, asOf: '2026-09-14T12:30:00Z' })).toEqual({
      beliefId: GOAL_ID,
      asOf: '2026-09-14T12:30:00Z',
    });
    expectInvalidArguments(() => getBelief.normalize({ beliefId: GOAL_ID, bogus: 1 }));
  });
});

describe('list_unknowns / list_observations normalization', () => {
  it('list_unknowns validates the status vocabulary', () => {
    expect(listUnknowns.normalize({ status: 'open', limit: 5 })).toEqual({
      status: 'open',
      limit: 5,
    });
    expectInvalidArguments(() => listUnknowns.normalize({ status: 'gone' }));
  });

  it('list_observations validates ISO instants and the source-kind vocabulary', () => {
    const args = listObservations.normalize({
      sourceKind: 'person',
      observedFrom: '2026-09-01T00:00:00.000Z',
      observedTo: '2026-09-30T23:59:59Z',
      limit: 20,
    });
    expect(args).toEqual({
      sourceKind: 'person',
      observedFrom: '2026-09-01T00:00:00.000Z',
      observedTo: '2026-09-30T23:59:59Z',
      limit: 20,
    });
    expectInvalidArguments(() => listObservations.normalize({ observedFrom: 'yesterday' }));
    expectInvalidArguments(() => listObservations.normalize({ sourceKind: 'whatsapp' }));
  });
});

describe('request_investigation normalization (the gated tool)', () => {
  const valid = {
    title: 'Churn root cause',
    knowledgeObjective: 'Identify why churn spiked in October.',
    informationValue: 0.8,
    urgency: 'high',
    targetConfidence: 0.9,
    investigationBudgetAmount: 50000,
    investigationBudgetCurrency: 'EUR',
    completionCriteria: 'A ranked driver list with supporting evidence.',
  };

  it('normalizes a full proposal, including the reserved gated arguments', () => {
    const args = requestInvestigation.normalize({
      ...valid,
      currentConfidence: 0.2,
      rewardBudgetAmount: 1000,
      rewardBudgetCurrency: 'EUR',
      justification: 'board concern',
      idempotencyKey: 'mission:churn-001',
    });
    expect(args).toEqual({
      title: valid.title,
      knowledgeObjective: valid.knowledgeObjective,
      informationValue: valid.informationValue,
      urgency: valid.urgency,
      targetConfidence: valid.targetConfidence,
      currentConfidence: 0.2,
      rewardBudget: { amount: 1000, currency: 'EUR' },
      investigationBudget: { amount: 50000, currency: 'EUR' },
      completionCriteria: valid.completionCriteria,
      affectedGoalId: null,
      unknownId: null,
      justification: 'board concern',
      idempotencyKey: 'mission:churn-001',
    });
  });

  it('defaults: currentConfidence 0, reward budget zero in the investigation currency', () => {
    const args = requestInvestigation.normalize(valid);
    expect(args.currentConfidence).toBe(0);
    expect(args.rewardBudget).toEqual({ amount: 0, currency: 'EUR' });
    expect(args.investigationBudget).toEqual({ amount: 50000, currency: 'EUR' });
    expect(args.idempotencyKey).toBeNull();
  });

  it('enforces the confidence-gap rule (a mission must plan to learn)', () => {
    expectInvalidArguments(() =>
      requestInvestigation.normalize({ ...valid, currentConfidence: 0.9, targetConfidence: 0.9 }),
    );
    expectInvalidArguments(() =>
      requestInvestigation.normalize({ ...valid, currentConfidence: 0.95, targetConfidence: 0.9 }),
    );
  });

  it('validates units, currencies and required fields', () => {
    expectInvalidArguments(() => requestInvestigation.normalize({ ...valid, informationValue: 5 }));
    expectInvalidArguments(() =>
      requestInvestigation.normalize({ ...valid, investigationBudgetCurrency: 'euros' }),
    );
    expectInvalidArguments(() => requestInvestigation.normalize({ ...valid, urgency: 'asap' }));
    expectInvalidArguments(() => {
      const { title, ...withoutTitle } = valid;
      void title;
      return requestInvestigation.normalize(withoutTitle);
    });
  });
});
