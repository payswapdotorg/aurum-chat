// Unit tests for the cognition module's pure logic: the canonical §19
// loop vocabulary/order/derivation (loop.ts) and the deterministic
// ADR-0018 acquisition-signal derivation (signals.ts). No database.

import { describe, expect, it } from 'vitest';
import {
  EXECUTION_STATES,
  FINAL_STAGE_NUMBER,
  LOOP_STAGES,
  nextStageAfterCompleted,
  outcomeKindForActionGate,
  stageAtNumber,
  stageNumberOf,
  type ActionGateResult,
} from '../loop';
import {
  DEFAULT_INVESTIGATION_COST,
  NEUTRAL_SIGNAL,
  deriveAcquisitionSignals,
  personTopicCoverage,
  type TransactiveCoverageRow,
} from '../signals';

describe('LOOP_STAGES (the frozen §19 canonical execution)', () => {
  it('is exactly the twelve §19 arrow targets, in order', () => {
    // ARCHITECTURE.md §19: observation → evidence/memory → world update
    // → epistemic evaluation → goal evaluation → unknown/mission
    // evaluation → knowledge acquisition → model update →
    // risk/opportunity/capability analysis → recommendation/ask/proposal/
    // action → outcome → learning.
    expect(LOOP_STAGES).toEqual([
      'observation',
      'evidence-memory',
      'world-update',
      'epistemic-evaluation',
      'goal-evaluation',
      'unknown-mission-evaluation',
      'knowledge-acquisition',
      'model-update',
      'risk-opportunity-capability-analysis',
      'recommendation-ask-proposal-action',
      'outcome',
      'learning',
    ]);
  });

  it('has twelve stages with unique slugs', () => {
    expect(LOOP_STAGES).toHaveLength(12);
    expect(FINAL_STAGE_NUMBER).toBe(12);
    expect(new Set(LOOP_STAGES).size).toBe(12);
  });

  it('maps stages to 1-based canonical positions and back', () => {
    expect(stageNumberOf('observation')).toBe(1);
    expect(stageNumberOf('learning')).toBe(12);
    for (const stage of LOOP_STAGES) {
      expect(stageAtNumber(stageNumberOf(stage))).toBe(stage);
    }
    expect(stageAtNumber(0)).toBeNull();
    expect(stageAtNumber(13)).toBeNull();
    expect(stageAtNumber(1.5)).toBeNull();
  });

  it('computes the next stage after completed stages, null past the end', () => {
    expect(nextStageAfterCompleted(0)).toBe('observation');
    expect(nextStageAfterCompleted(6)).toBe('knowledge-acquisition');
    expect(nextStageAfterCompleted(11)).toBe('learning');
    expect(nextStageAfterCompleted(12)).toBeNull();
    expect(nextStageAfterCompleted(-1)).toBeNull();
  });

  it('keeps the lifecycle states of an asynchronous/resumable execution', () => {
    expect(EXECUTION_STATES).toEqual([
      'running',
      'awaiting_input',
      'awaiting_approval',
      'completed',
      'abandoned',
    ]);
  });
});

describe('outcomeKindForActionGate (deterministic outcome recording)', () => {
  const request = (overrides: Partial<ActionGateResult['actionRequest']> = {}): ActionGateResult['actionRequest'] => ({
    id: 'req-1',
    actionKind: 'employee-messaging',
    authorityLevel: 'ASK',
    status: 'approved',
    outcome: 'allowed',
    resolvedVia: 'built-in',
    ...overrides,
  });

  it('derives no-action when the cycle proposed no action', () => {
    expect(outcomeKindForActionGate({ actionRequest: null, gate: null, resolution: null })).toBe('no-action');
  });

  it('derives action-authorized when the matrix allowed the action', () => {
    expect(
      outcomeKindForActionGate({ actionRequest: request({ status: 'approved', outcome: 'allowed' }), gate: 'allowed', resolution: null }),
    ).toBe('action-authorized');
  });

  it('derives action-refused when the matrix forbade the action', () => {
    expect(
      outcomeKindForActionGate({ actionRequest: request({ status: 'rejected', outcome: 'forbidden' }), gate: 'forbidden', resolution: null }),
    ).toBe('action-refused');
  });

  it('lets the human decision resolve an approval_required gate both ways', () => {
    expect(
      outcomeKindForActionGate({
        actionRequest: request({ status: 'approved', outcome: 'approval_required' }),
        gate: 'approval_required',
        resolution: 'approved',
      }),
    ).toBe('action-authorized');
    expect(
      outcomeKindForActionGate({
        actionRequest: request({ status: 'rejected', outcome: 'approval_required' }),
        gate: 'approval_required',
        resolution: 'rejected',
      }),
    ).toBe('action-refused');
  });
});

describe('personTopicCoverage (transactive-memory relevance)', () => {
  const entries: TransactiveCoverageRow[] = [
    { actorKind: 'person', actorId: 'p-1', topics: ['churn', 'pricing'] },
    { actorKind: 'person', actorId: 'p-1', topics: ['churn'] },
    { actorKind: 'person', actorId: 'p-2', topics: ['onboarding'] },
    { actorKind: 'agent', actorId: 'p-1', topics: ['churn', 'pricing'] }, // wrong kind — ignored
    { actorKind: 'team', actorId: null, topics: ['churn'] },
  ];

  it('computes the share of focus topics attributed to the person', () => {
    expect(personTopicCoverage('p-1', ['churn', 'pricing', 'onboarding'], entries)).toBeCloseTo(2 / 3);
    expect(personTopicCoverage('p-2', ['churn', 'pricing', 'onboarding'], entries)).toBeCloseTo(1 / 3);
    expect(personTopicCoverage('p-3', ['churn'], entries)).toBe(0);
  });

  it('is order-independent and set-semantic (duplicates do not double-count)', () => {
    const shuffled = [...entries].reverse();
    expect(personTopicCoverage('p-1', ['churn', 'pricing'], shuffled)).toBe(1);
    expect(personTopicCoverage('p-1', ['churn', 'churn'], entries)).toBe(1);
  });

  it('returns 0 for an empty focus', () => {
    expect(personTopicCoverage('p-1', [], entries)).toBe(0);
  });
});

describe('deriveAcquisitionSignals (the deterministic workflow-level default)', () => {
  const menu = [
    { kind: 'person' as const, id: 'p-1', label: 'VP Customer Success' },
    { kind: 'person' as const, label: 'label-only person' },
    { kind: 'system' as const, label: 'billing-export' },
    { kind: 'analysis' as const, label: 'cohort model' },
  ];

  it('derives one signal vector per menu entry, menu order preserved', () => {
    const signals = deriveAcquisitionSignals({
      focusTopics: ['churn'],
      menu,
      transactive: [{ actorKind: 'person', actorId: 'p-1', topics: ['churn'] }],
    });
    expect(signals).toHaveLength(menu.length);
    expect(signals.map((s) => s.kind)).toEqual(['person', 'person', 'system', 'analysis']);
    expect(signals[0]).toMatchObject({ id: 'p-1', label: 'VP Customer Success' });
    expect(signals[1]).toMatchObject({ id: null, label: 'label-only person' });
  });

  it('grounds person relevance in transactive coverage and leaves the rest neutral', () => {
    const signals = deriveAcquisitionSignals({
      focusTopics: ['churn', 'pricing'],
      menu,
      transactive: [{ actorKind: 'person', actorId: 'p-1', topics: ['churn'] }],
    });
    // p-1 covers half the focus topics.
    expect(signals[0]!.relevance).toBe(0.5);
    // id-less persons, systems, analyses: no per-source coverage exists —
    // neutral prior, never invented confidence.
    for (const signal of [signals[1], signals[2], signals[3]]) {
      expect(signal!.relevance).toBe(NEUTRAL_SIGNAL);
    }
    for (const signal of signals) {
      expect(signal.reliability).toBe(NEUTRAL_SIGNAL);
      expect(signal.freshness).toBe(NEUTRAL_SIGNAL);
      expect(signal.authority).toBe(NEUTRAL_SIGNAL);
      expect(signal.expectedQuality).toBe(NEUTRAL_SIGNAL);
      expect(signal.priorContributionValue).toBe(0);
      expect(signal.cost).toBe(DEFAULT_INVESTIGATION_COST);
      expect(signal.access).toBe('allowed');
    }
  });

  it('is deterministic: the same inputs always produce the same vectors', () => {
    const input = {
      focusTopics: ['churn'],
      menu,
      transactive: [
        { actorKind: 'person' as const, actorId: 'p-1', topics: ['churn'] },
        { actorKind: 'person' as const, actorId: 'p-2', topics: ['churn'] },
      ],
    };
    expect(deriveAcquisitionSignals(input)).toEqual(deriveAcquisitionSignals(input));
  });

  it('never invents coverage: a person absent from memory scores 0 relevance', () => {
    const signals = deriveAcquisitionSignals({
      focusTopics: ['churn'],
      menu: [{ kind: 'person', id: 'p-unknown', label: null }],
      transactive: [],
    });
    expect(signals[0]!.relevance).toBe(0);
  });
});
