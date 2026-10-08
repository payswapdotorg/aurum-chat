// Unit proofs for the closed-loop module (W140). Pure, no database:
// the deterministic adjustment/metric math, the class-locked deviation
// validators (acceptance clause 1), the policy-authority refusals
// (acceptance clause 2) and the structural no-mutation tripwire.
//
// Covered:
//   * applyRankingSignals — the single definition of how recorded
//     signals change future ranking (fold, order, clamp, rounding);
//   * the metric math — magnitude, calibration error, observed score,
//     signal derivation, gap closure, recurrence, improvement verdict;
//   * THE DEVIATION DISTINCTION (acceptance clause 1): a knowledge
//     deviation input can never carry the reality class's fields and
//     vice versa — each class's validator rejects the other's shape;
//   * THE POLICY-AUTHORITY REFUSALS (acceptance clause 2): policy/
//     settings/authority-shaped signal targets are refused with the
//     dedicated typed code; the seam vocabulary is exactly the three
//     ranking input channels;
//   * THE STRUCTURAL NO-MUTATION TRIPWIRE: the service imports only
//     READ operations from the seven seam contracts (source-scanned —
//     the agent-exchange structural-regression precedent).

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyRankingSignals,
  assertClosedLoopTenantContext,
  calibrationErrorOf,
  ClosedLoopError,
  deriveSignalDirection,
  deriveSignalMagnitude,
  deviationRecurrenceOf,
  gapClosureRateOf,
  improvementVerdictOf,
  isCompanyModelSubjectKey,
  isPolicySurfaceWord,
  magnitudeOf,
  observedScoreOf,
  POLICY_SURFACE_WORDS,
  RANKING_TARGET_SEAMS,
  validateApplyRankingSignalInput,
  validateKnowledgeDeviationInput,
  validateRealityDeviationInput,
  validateRecordLoopCycleInput,
} from '../contract';
import type { ClosedLoopErrorCode } from '../contract';

const GOAL_ID = '11111111-1111-4111-8111-111111111111';
const CYCLE_ID = '22222222-2222-4222-8222-222222222222';
const PLAN_ID = '33333333-3333-4333-8333-333333333333';
const RUN_ID = '44444444-4444-4444-8444-444444444444';
const GAP_ID = '55555555-5555-4555-8555-555555555555';
const SNAPSHOT_ID = '66666666-6666-4666-8666-666666666666';
const UPDATE_ID = '77777777-7777-4777-8777-777777777777';

function expectCode(code: ClosedLoopErrorCode, fn: () => unknown): ClosedLoopError {
  try {
    fn();
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(ClosedLoopError);
    const typed = error as ClosedLoopError;
    expect(typed.code).toBe(code);
    return typed;
  }
}

describe('closed-loop unit — the deterministic loop math', () => {
  it('magnitudeOf measures |observed − expected| at 4 decimals', () => {
    expect(magnitudeOf(0.5, 0.9)).toBe(0.4);
    expect(magnitudeOf(0.9, 0.5)).toBe(0.4);
    expect(magnitudeOf(0.33333, 0.66666)).toBe(0.3333);
    expect(magnitudeOf(0.5, 0.5)).toBe(0);
  });

  it('applyRankingSignals folds signals in order, clamped to [0,1]', () => {
    // One full-magnitude raise moves a quarter of the scale.
    expect(applyRankingSignals(0.5, [{ direction: 'raise', magnitude: 1 }])).toBe(0.75);
    expect(applyRankingSignals(0.5, [{ direction: 'lower', magnitude: 1 }])).toBe(0.25);
    // Magnitude scales the step; order matters and is deterministic.
    expect(applyRankingSignals(0.5, [{ direction: 'raise', magnitude: 0.5 }])).toBe(0.625);
    expect(applyRankingSignals(0.5, [
      { direction: 'raise', magnitude: 1 },
      { direction: 'lower', magnitude: 0.5 },
    ])).toBe(0.625);
    // Order matters exactly at the clamp boundary: raising first
    // saturates at 1 before the lower lands; lowering first never does.
    expect(applyRankingSignals(0.9, [
      { direction: 'raise', magnitude: 1 },
      { direction: 'lower', magnitude: 1 },
    ])).toBe(0.75);
    expect(applyRankingSignals(0.9, [
      { direction: 'lower', magnitude: 1 },
      { direction: 'raise', magnitude: 1 },
    ])).toBe(0.9);
    // Clamped at both ends — never an extreme jump.
    expect(applyRankingSignals(0.9, [{ direction: 'raise', magnitude: 1 }])).toBe(1);
    expect(applyRankingSignals(0.1, [{ direction: 'lower', magnitude: 1 }])).toBe(0);
    // No signals: the base score, unchanged.
    expect(applyRankingSignals(0.42, [])).toBe(0.42);
  });

  it('calibrationErrorOf and observedScoreOf are the honest measurement', () => {
    expect(calibrationErrorOf(0.5, 0.9)).toBe(0.4);
    expect(calibrationErrorOf(0.9, 0.5)).toBe(0.4);
    // An unmeasured cycle stays unmeasured — never defaulted.
    expect(observedScoreOf([])).toBeNull();
    expect(observedScoreOf([0.9])).toBe(0.9);
    expect(observedScoreOf([0.8, 0.9])).toBe(0.85);
    expect(observedScoreOf([1, 0, 0.5])).toBe(0.5);
  });

  it('deriveSignalDirection/Magnitude convert a calibration gap into a signal', () => {
    expect(deriveSignalDirection(0.5, 0.9)).toBe('raise');
    expect(deriveSignalDirection(0.9, 0.5)).toBe('lower');
    expect(deriveSignalMagnitude(0.5, 0.9)).toBe(0.4);
    // A zero gap still yields a minimal (non-zero) magnitude.
    expect(deriveSignalMagnitude(0.5, 0.5)).toBeGreaterThan(0);
    expect(deriveSignalMagnitude(0.5, 0.5)).toBeLessThanOrEqual(1);
  });

  it('gapClosureRateOf and deviationRecurrenceOf compare consecutive cycles honestly', () => {
    // No previous knowledge deviations: nothing to close — stated null.
    expect(gapClosureRateOf([], ['g1'])).toBeNull();
    // All previous gaps recur: no closure.
    expect(gapClosureRateOf(['g1'], ['g1'])).toBe(0);
    // None recur: fully closed.
    expect(gapClosureRateOf(['g1', 'g2'], ['g3'])).toBe(1);
    expect(gapClosureRateOf(['g1', 'g2', 'g3'], ['g1'])).toBe(0.6667);
    // No previous cycle: recurrence is stated null, not defaulted.
    expect(deviationRecurrenceOf(null, ['r1'])).toBeNull();
    expect(deviationRecurrenceOf(['r1'], ['r1', 'r2'])).toBe(0.5);
    expect(deviationRecurrenceOf(['r9'], ['r1', 'r2'])).toBe(0);
    expect(deviationRecurrenceOf(['r1'], [])).toBe(0);
  });

  it('improvementVerdictOf never fabricates improvement', () => {
    expect(improvementVerdictOf([])).toBe('insufficient_evidence');
    expect(improvementVerdictOf([0.4])).toBe('insufficient_evidence');
    expect(improvementVerdictOf([null, null])).toBe('insufficient_evidence');
    expect(improvementVerdictOf([0.4, 0.3, 0.2])).toBe('improved');
    expect(improvementVerdictOf([0.4, 0.4])).toBe('flat');
    expect(improvementVerdictOf([0.2, 0.4])).toBe('degraded');
    // Unmeasured points are skipped, not counted as improvement.
    expect(improvementVerdictOf([0.4, null, 0.3])).toBe('improved');
  });
});

describe('closed-loop unit — the deviation-class distinction (acceptance clause 1)', () => {
  it('a reality deviation requires expected/observed and the class-legal source shape', () => {
    const valid = validateRealityDeviationInput(
      { sourceKind: 'execution_run', sourceRef: RUN_ID, planId: PLAN_ID, expected: 0.5, observed: 0.9, note: 'run underdelivered' },
      GOAL_ID,
    );
    expect(valid.expected).toBe(0.5);
    expect(valid.observed).toBe(0.9);
    // execution_run citations require the plan.
    expectCode('invalid_deviation_input', () =>
      validateRealityDeviationInput(
        { sourceKind: 'execution_run', sourceRef: RUN_ID, expected: 0.5, observed: 0.9, note: 'no plan' },
        GOAL_ID,
      ),
    );
    // planId is illegal on the other source kinds.
    expectCode('invalid_deviation_input', () =>
      validateRealityDeviationInput(
        { sourceKind: 'fabric_lease', sourceRef: RUN_ID, planId: PLAN_ID, expected: 0.5, observed: 0.9, note: 'plan on a lease' },
        GOAL_ID,
      ),
    );
    // A goal_metric deviation must cite the cycle's own goal.
    expectCode('invalid_deviation_input', () =>
      validateRealityDeviationInput(
        { sourceKind: 'goal_metric', sourceRef: RUN_ID, expected: 0.5, observed: 0.9, note: 'foreign goal metric' },
        GOAL_ID,
      ),
    );
    expect(
      validateRealityDeviationInput(
        { sourceKind: 'goal_metric', sourceRef: GOAL_ID, expected: 0.5, observed: 0.9, note: 'own goal metric' },
        GOAL_ID,
      ).sourceRef,
    ).toBe(GOAL_ID);
  });

  it('a knowledge deviation requires severity and the class-legal source shape', () => {
    const valid = validateKnowledgeDeviationInput(
      { sourceKind: 'coverage_gap', sourceRef: GAP_ID, snapshotId: SNAPSHOT_ID, severity: 0.7, note: 'material gap' },
    );
    expect(valid.severity).toBe(0.7);
    expect(valid.snapshotRef).toBe(SNAPSHOT_ID);
    // coverage_gap citations require the snapshot.
    expectCode('invalid_deviation_input', () =>
      validateKnowledgeDeviationInput(
        { sourceKind: 'coverage_gap', sourceRef: GAP_ID, severity: 0.7, note: 'no snapshot' },
      ),
    );
    // snapshotId is illegal on learning_update citations.
    expectCode('invalid_deviation_input', () =>
      validateKnowledgeDeviationInput(
        { sourceKind: 'learning_update', sourceRef: UPDATE_ID, snapshotId: SNAPSHOT_ID, severity: 0.7, note: 'snapshot on an update' },
      ),
    );
    // severity is (0,1] — zero and above-one are refused.
    expectCode('invalid_deviation_input', () =>
      validateKnowledgeDeviationInput(
        { sourceKind: 'learning_update', sourceRef: UPDATE_ID, severity: 0, note: 'zero severity' },
      ),
    );
    expectCode('invalid_deviation_input', () =>
      validateKnowledgeDeviationInput(
        { sourceKind: 'learning_update', sourceRef: UPDATE_ID, severity: 1.2, note: 'over-unit severity' },
      ),
    );
  });

  it('THE CLASS LOCK: neither deviation shape satisfies the other class validator', () => {
    const realityShaped = {
      sourceKind: 'execution_run',
      sourceRef: RUN_ID,
      planId: PLAN_ID,
      expected: 0.5,
      observed: 0.9,
      note: 'the world differed',
    };
    const knowledgeShaped = {
      sourceKind: 'coverage_gap',
      sourceRef: GAP_ID,
      snapshotId: SNAPSHOT_ID,
      severity: 0.7,
      note: 'knowledge was insufficient',
    };
    // A reality-shaped input is refused by the knowledge validator —
    // it carries the reality class's fields.
    expectCode('invalid_deviation_input', () => validateKnowledgeDeviationInput(realityShaped));
    // A knowledge-shaped input is refused by the reality validator —
    // it carries the knowledge class's fields.
    expectCode('invalid_deviation_input', () => validateRealityDeviationInput(knowledgeShaped, GOAL_ID));
    // And the legitimate shapes cross-clean: the valid reality input
    // passes its own validator, the valid knowledge input its own.
    expect(validateRealityDeviationInput(realityShaped, GOAL_ID).sourceKind).toBe('execution_run');
    expect(validateKnowledgeDeviationInput(knowledgeShaped).sourceKind).toBe('coverage_gap');
  });

  it('recordLoopCycle validates both classes together', () => {
    const valid = validateRecordLoopCycleInput({
      goalId: GOAL_ID,
      predictedScore: 0.5,
      rationale: 'cycle one',
      realityDeviations: [
        { sourceKind: 'execution_run', sourceRef: RUN_ID, planId: PLAN_ID, expected: 0.5, observed: 0.9, note: 'run outcome' },
      ],
      knowledgeDeviations: [
        { sourceKind: 'learning_update', sourceRef: UPDATE_ID, severity: 0.4, note: 'model was wrong' },
      ],
    });
    expect(valid.realityDeviations).toHaveLength(1);
    expect(valid.knowledgeDeviations).toHaveLength(1);
    expectCode('invalid_cycle_input', () =>
      validateRecordLoopCycleInput({ goalId: GOAL_ID, rationale: 'no prediction' }),
    );
    expectCode('invalid_cycle_input', () =>
      validateRecordLoopCycleInput({ goalId: GOAL_ID, predictedScore: 1.5, rationale: 'out of range' }),
    );
  });
});

describe('closed-loop unit — the policy-authority law (acceptance clause 2)', () => {
  it('the signal-target vocabulary is exactly the three ranking input channels', () => {
    expect([...RANKING_TARGET_SEAMS]).toEqual(['info_strategy', 'org_lab', 'company_model']);
  });

  it('policy/settings/authority-shaped targets are refused with the dedicated typed code', () => {
    for (const word of POLICY_SURFACE_WORDS) {
      expect(isPolicySurfaceWord(word)).toBe(true);
      const refused = expectCode('policy_mutation_refused', () =>
        validateApplyRankingSignalInput({
          cycleId: CYCLE_ID,
          targetSeam: word,
          targetRef: 'anything',
          direction: 'raise',
          magnitude: 0.5,
          basis: 'reality_deviation',
          rationale: 'try to touch policy',
        }),
      );
      expect(refused.message).toContain('policy');
    }
    // The refusal fires on the query surface too.
    expectCode('policy_mutation_refused', () =>
      validateApplyRankingSignalInput({
        cycleId: CYCLE_ID,
        targetSeam: 'settings',
        targetRef: 'x',
        direction: 'raise',
        magnitude: 0.5,
        basis: 'reality_deviation',
        rationale: 'r',
      }),
    );
  });

  it('a legal signal input validates; the malformed ones refuse with invalid_signal_input', () => {
    const valid = validateApplyRankingSignalInput({
      cycleId: CYCLE_ID,
      targetSeam: 'org_lab',
      targetRef: 'candidate-a',
      direction: 'raise',
      magnitude: 0.4,
      basis: 'reality_deviation',
      rationale: 'the world outperformed the prediction',
    });
    expect(valid.targetSeam).toBe('org_lab');
    expect(valid.magnitude).toBe(0.4);
    expectCode('invalid_signal_input', () =>
      validateApplyRankingSignalInput({
        cycleId: CYCLE_ID,
        targetSeam: 'not_a_seam',
        targetRef: 'x',
        direction: 'raise',
        magnitude: 0.5,
        basis: 'reality_deviation',
        rationale: 'r',
      }),
    );
    expectCode('invalid_signal_input', () =>
      validateApplyRankingSignalInput({
        cycleId: CYCLE_ID,
        targetSeam: 'org_lab',
        targetRef: 'x',
        direction: 'raise',
        magnitude: 0,
        basis: 'reality_deviation',
        rationale: 'r',
      }),
    );
    expectCode('invalid_signal_input', () =>
      validateApplyRankingSignalInput({
        cycleId: CYCLE_ID,
        targetSeam: 'org_lab',
        targetRef: 'x',
        direction: 'raise',
        magnitude: 1.5,
        basis: 'reality_deviation',
        rationale: 'r',
      }),
    );
    expectCode('invalid_signal_input', () =>
      validateApplyRankingSignalInput({
        cycleId: CYCLE_ID,
        targetSeam: 'org_lab',
        targetRef: 'x',
        direction: 'sideways',
        magnitude: 0.5,
        basis: 'reality_deviation',
        rationale: 'r',
      }),
    );
  });

  it('company-model subject keys validate through the learning contract vocabulary', () => {
    expect(isCompanyModelSubjectKey('company')).toBe(true);
    expect(isCompanyModelSubjectKey(`source:${RUN_ID}`)).toBe(true);
    expect(isCompanyModelSubjectKey('term:churn')).toBe(true);
    // Unknown kinds (not in the learning contract's vocabulary) refuse.
    expect(isCompanyModelSubjectKey('spaceship:enterprise')).toBe(false);
    expect(isCompanyModelSubjectKey('source')).toBe(false);
    expect(isCompanyModelSubjectKey('source:')).toBe(false);
    expect(isCompanyModelSubjectKey(':key')).toBe(false);
  });

  it('an explicit TenantContext is asserted, never ambient', () => {
    expectCode('invalid_context', () =>
      assertClosedLoopTenantContext({ tenantId: '', principalId: 'p', authority: [] }),
    );
    expectCode('invalid_context', () =>
      assertClosedLoopTenantContext({ tenantId: 't', principalId: '', authority: [] }),
    );
    assertClosedLoopTenantContext({ tenantId: 't', principalId: 'p', authority: [] });
  });
});

describe('closed-loop unit — the structural no-mutation tripwire', () => {
  it('the service imports ONLY read operations from the seven seam contracts', () => {
    const source = readFileSync(
      path.join(process.cwd(), 'src/modules/closed-loop/service.ts'),
      'utf8',
    );
    // Every legal seam import line, e.g.:
    //   import { getGoal, GoalsError } from '@/modules/goals/contract';
    // TYPE-only imports are skipped — types never mutate anything.
    const importRe = /import\s+(type\s+)?\{([^}]+)\}\s+from\s+'@\/modules\/([a-z-]+)\/contract'/g;
    const seamImports = new Map<string, Set<string>>();
    for (const match of source.matchAll(importRe)) {
      if (match[1]) continue; // `import type { … }` — compile-time only.
      const names = match[2]
        .split(',')
        .map((one) => one.trim().split(/\s+as\s+/)[0].trim())
        .filter((one) => one.length > 0);
      const module = match[3];
      if (!seamImports.has(module)) seamImports.set(module, new Set());
      for (const name of names) seamImports.get(module)!.add(name);
    }

    // The consumed seams (the loop's connection map).
    expect([...seamImports.keys()].sort()).toEqual([
      'agent-exchange',
      'coverage',
      'execution-fabric',
      'goals',
      'info-strategy',
      'learning',
      'org-lab',
    ]);

    // The read-only allowlist: existence/state/snapshot reads and the
    // seam's own typed error + pure vocabulary guards. Any mutation-
    // shaped import (recordX/adjustX/createX/setX/...) fails the tripwire.
    const readOnly: Record<string, readonly string[]> = {
      goals: ['getGoal', 'GoalsError'],
      'agent-exchange': ['listExecutionRuns', 'AgentExchangeError'],
      'execution-fabric': ['getFabricLease', 'ExecutionFabricError'],
      coverage: ['listGaps', 'CoverageError'],
      learning: ['listLearningUpdates', 'isCompanyModelSubjectKind', 'LearningError'],
      'info-strategy': ['getStrategy', 'InfoStrategyError'],
      'org-lab': ['getCandidate', 'getRecommendation', 'OrgLabError'],
    };
    for (const [module, names] of seamImports) {
      const allowed = readOnly[module];
      expect(allowed, `unexpected seam import: ${module}`).toBeDefined();
      for (const name of names) {
        expect(
          allowed.includes(name),
          `${module}/${name} is not a read operation — the closed loop never mutates a seam`,
        ).toBe(true);
      }
    }
  });

  it('the contract exports no policy-mutating or seam-mutating operation', () => {
    // The public surface is exactly the loop's own operations — nothing
    // that could act on another module's state.
    const contractSource = readFileSync(
      path.join(process.cwd(), 'src/modules/closed-loop/contract.ts'),
      'utf8',
    );
    const mutationWords = [
      'recordHandoff',
      'recordExecutionRun',
      'adjustStrategy',
      'defineStrategy',
      'recordLearningUpdate',
      'recordCalibration',
      'recordRecommendation',
      'setAuthorityPolicy',
      'authorizeAction',
    ];
    for (const word of mutationWords) {
      expect(contractSource, `the contract must not export ${word}`).not.toContain(`  ${word},`);
    }
  });
});
