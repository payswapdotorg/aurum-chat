// Unit tests for the agent-evaluation module's pure logic (W024 — Agent
// Evaluation and Termination): the deterministic measurement core, the
// lifecycle routing and the input guards. No database, no context, no
// clock — every test pins a total function of its arguments.
//
//  * measurement — the six dimensions the work item names verbatim
//    (outcome, cost, quality, utilization, security and the replacement
//    cost comparison) computed over CONTRACT-shaped data: counts, sums,
//    rates and windows are deterministic and honest (null / unknown
//    when there is no basis, never a fabricated zero);
//  * policy — the §15 tail vocabulary, the terminal/live partition, the
//    matrix routing (only terminate gates; the §20 kind/level) and the
//    deterministic gate-outcome → status mapping;
//  * validation — the strict input guards (unknown keys rejected,
//    caller-forgeable audit fields unsmuggleable, replacement options
//    1..9 with distinct kinds and at most one recommendation, the
//    modify/terminate field shapes).

import { describe, expect, it } from 'vitest';
import type { AgentExecution, AgentExecutionAttempt, AgentPermissionScope } from '@/modules/agents/contract';
import type { Outcome } from '@/modules/learning/contract';
import {
  compareReplacementCost,
  computeCostMetrics,
  computeOutcomeMetrics,
  computeQualityMetrics,
  computeSecurityMetrics,
  computeUtilizationMetrics,
  deriveWindow,
} from '../measurement';
import {
  AGENT_DECISION_STATUSES,
  AGENT_LIFECYCLE_CHANGES,
  AGENT_REPLACEMENT_KINDS,
  AGENT_TERMINATION_ACTION_KIND,
  AGENT_TERMINATION_AUTHORITY_LEVEL,
  canDecideAgentLifecycle,
  isAgentDecisionStatus,
  isAgentLifecycleChange,
  isAgentReplacementKind,
  isMatrixGated,
  isTerminalDecisionStatus,
  statusForGateOutcome,
} from '../policy';
import { AgentEvaluationError } from '../errors';
import type { DecideAgentLifecycleInput, RecordAgentEvaluationInput } from '../types';
import {
  validateDecideAgentLifecycleInput,
  validateRecordAgentEvaluationInput,
} from '../validation';

// ---------------------------------------------------------------------------
// Fixtures (contract-shaped, minimal)
// ---------------------------------------------------------------------------

function execution(overrides: Partial<AgentExecution> = {}): AgentExecution {
  return {
    id: 'exec-1',
    tenantId: 't1',
    agentId: 'a1',
    provider: 'openai-assistants',
    task: {},
    requestedPermissions: ['observe'],
    authorityLevel: 'OBSERVE',
    idempotencyKey: null,
    correlationId: null,
    causationId: null,
    status: 'succeeded',
    policy: {
      actionRequestId: 'req-1',
      outcome: 'allowed',
      resolvedVia: 'built-in',
    },
    maxAttempts: 3,
    attemptsCount: 1,
    result: { output: {}, summary: null },
    errorCode: null,
    errorDetail: null,
    costMinor: 100,
    costCurrency: 'USD',
    submittedBy: 'principal-1',
    submittedAt: '2027-01-02T03:04:05.000Z',
    completedAt: '2027-01-02T03:04:06.000Z',
    updatedAt: '2027-01-02T03:04:06.000Z',
    ...overrides,
  };
}

function attempt(overrides: Partial<AgentExecutionAttempt> = {}): AgentExecutionAttempt {
  return {
    id: 'att-1',
    tenantId: 't1',
    executionId: 'exec-1',
    attemptNumber: 1,
    provider: 'openai-assistants',
    runtimeAccountId: null,
    routing: null,
    status: 'completed',
    retryable: false,
    errorCode: null,
    errorDetail: null,
    result: { output: {}, summary: null },
    usage: { inputTokens: 1200, outputTokens: 800, operations: 3 },
    costMinor: 100,
    costCurrency: 'USD',
    providerTaskId: 'task-1',
    latencyMs: 1500,
    dispatchedAt: '2027-01-02T03:04:05.100Z',
    finishedAt: '2027-01-02T03:04:06.500Z',
    dispatchedBy: 'principal-1',
    ...overrides,
  };
}

function outcome(overrides: Partial<Outcome> & Pick<Outcome, 'id'>): Outcome {
  return {
    tenantId: 't1',
    subject: { kind: 'agent', id: 'a1', label: null },
    metricName: 'tickets triaged',
    metricUnit: 'tickets',
    direction: 'at_least',
    baseline: 10,
    expected: 20,
    horizon: null,
    affectedGoals: [],
    originExecutionId: null,
    status: 'open',
    realization: null,
    abandonment: null,
    measurementCount: 0,
    latestMeasurement: null,
    createdAt: '2027-01-01T00:00:00.000Z',
    lastChange: {
      actor: { kind: 'system', id: null, label: 'test' },
      changedByPrincipal: 'p1',
      rationale: null,
      recordedAt: '2027-01-01T00:00:00.000Z',
    },
    ...overrides,
  } as Outcome;
}

// ---------------------------------------------------------------------------
// The OUTCOME dimension
// ---------------------------------------------------------------------------

describe('computeOutcomeMetrics', () => {
  it('measures an empty basis as honest zeros', () => {
    expect(computeOutcomeMetrics([])).toEqual({
      outcomesTotal: 0,
      open: 0,
      settled: 0,
      abandoned: 0,
      met: 0,
      exceeded: 0,
      missed: 0,
      settledExpectedTotal: 0,
      settledRealizedTotal: 0,
      netVarianceVsExpected: 0,
    });
  });

  it('counts lifecycle states and assessments separately', () => {
    const metrics = computeOutcomeMetrics([
      outcome({ id: 'o1', status: 'open' }),
      outcome({ id: 'o2', status: 'abandoned' }),
      outcome({
        id: 'o3',
        status: 'settled',
        expected: 20,
        realization: {
          realizedValue: 25,
          varianceVsExpected: 5,
          improvementVsBaseline: 15,
          assessment: 'exceeded',
          fromMeasurementId: 'm1',
          note: null,
          actor: { kind: 'system', id: null, label: null },
          realizedByPrincipal: 'p1',
          settledAt: '2027-02-01T00:00:00.000Z',
        },
      }),
      outcome({
        id: 'o4',
        status: 'settled',
        expected: 30,
        realization: {
          realizedValue: 21,
          varianceVsExpected: -9,
          improvementVsBaseline: 1,
          assessment: 'missed',
          fromMeasurementId: 'm2',
          note: null,
          actor: { kind: 'system', id: null, label: null },
          realizedByPrincipal: 'p1',
          settledAt: '2027-02-02T00:00:00.000Z',
        },
      }),
    ]);
    expect(metrics.outcomesTotal).toBe(4);
    expect(metrics.open).toBe(1);
    expect(metrics.abandoned).toBe(1);
    expect(metrics.settled).toBe(2);
    expect(metrics.exceeded).toBe(1);
    expect(metrics.missed).toBe(1);
    expect(metrics.met).toBe(0);
    expect(metrics.settledExpectedTotal).toBe(50);
    expect(metrics.settledRealizedTotal).toBe(46);
    expect(metrics.netVarianceVsExpected).toBe(-4);
  });

  it('ignores realization data on non-settled outcomes (no zombie assessments)', () => {
    const metrics = computeOutcomeMetrics([
      outcome({ id: 'o1', status: 'open' }),
    ]);
    expect(metrics.settled).toBe(0);
    expect(metrics.met + metrics.exceeded + metrics.missed).toBe(0);
    expect(metrics.settledExpectedTotal).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The COST dimension
// ---------------------------------------------------------------------------

describe('computeCostMetrics', () => {
  it('sums execution cost and computes the per-succeeded average', () => {
    const metrics = computeCostMetrics(
      [
        execution({ id: 'e1', costMinor: 100, status: 'succeeded' }),
        execution({ id: 'e2', costMinor: 50, status: 'succeeded' }),
        execution({ id: 'e3', costMinor: 7, status: 'failed' }),
      ],
      [],
      false,
    );
    expect(metrics.totalCostMinor).toBe(157);
    expect(metrics.succeededCostMinor).toBe(150);
    expect(metrics.costPerSucceededMinor).toBe(79); // round(157 / 2)
    expect(metrics.executionsIncluded).toBe(3);
    expect(metrics.executionsTruncated).toBe(false);
    expect(metrics.costCurrency).toBe('USD');
  });

  it('reports null per-succeeded cost when nothing succeeded', () => {
    const metrics = computeCostMetrics(
      [execution({ id: 'e1', costMinor: 10, status: 'refused' })],
      [],
      false,
    );
    expect(metrics.costPerSucceededMinor).toBeNull();
    expect(metrics.succeededCostMinor).toBe(0);
  });

  it('sums usage across attempts and reports null when nothing was reported', () => {
    const withUsage = computeCostMetrics(
      [],
      [
        attempt({ usage: { inputTokens: 100, outputTokens: 50, operations: 2 } }),
        attempt({ usage: { inputTokens: 10, outputTokens: 5, operations: 1 } }),
      ],
      false,
    );
    expect(withUsage.inputTokensTotal).toBe(110);
    expect(withUsage.outputTokensTotal).toBe(55);
    expect(withUsage.operationsTotal).toBe(3);
    expect(withUsage.attemptsIncluded).toBe(2);

    const noUsage = computeCostMetrics(
      [],
      [attempt({ usage: { inputTokens: null, outputTokens: null, operations: null } })],
      false,
    );
    expect(noUsage.inputTokensTotal).toBeNull();
    expect(noUsage.outputTokensTotal).toBeNull();
    expect(noUsage.operationsTotal).toBeNull();
  });

  it('flags a truncated basis', () => {
    const metrics = computeCostMetrics([execution({ id: 'e1' })], [], true);
    expect(metrics.executionsTruncated).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The QUALITY dimension
// ---------------------------------------------------------------------------

describe('computeQualityMetrics', () => {
  it('distributes terminal statuses and computes the success rate over terminals only', () => {
    const metrics = computeQualityMetrics(
      [
        execution({ id: 'e1', status: 'succeeded' }),
        execution({ id: 'e2', status: 'succeeded' }),
        execution({ id: 'e3', status: 'failed' }),
        execution({ id: 'e4', status: 'refused' }),
        execution({ id: 'e5', status: 'cancelled' }),
        execution({ id: 'e6', status: 'queued' }),
      ],
      [],
    );
    expect(metrics.succeeded).toBe(2);
    expect(metrics.failed).toBe(1);
    expect(metrics.refused).toBe(1);
    expect(metrics.cancelled).toBe(1);
    expect(metrics.terminalCount).toBe(5);
    expect(metrics.successRate).toBe(0.4); // 2 / 5, rounded to 4 decimals
  });

  it('reports null success rate when nothing terminated (honest no-basis)', () => {
    const metrics = computeQualityMetrics(
      [execution({ id: 'e1', status: 'queued' }), execution({ id: 'e2', status: 'awaiting_approval' })],
      [],
    );
    expect(metrics.terminalCount).toBe(0);
    expect(metrics.successRate).toBeNull();
  });

  it('classifies attempt failures canonically and averages latency', () => {
    const metrics = computeQualityMetrics(
      [],
      [
        attempt({ errorCode: 'dispatch_failed', retryable: true, latencyMs: 100 }),
        attempt({ errorCode: 'dispatch_failed', retryable: true, latencyMs: 300 }),
        attempt({ errorCode: 'dispatch_rejected', retryable: false, latencyMs: 50 }),
        attempt({ errorCode: 'result_invalid', retryable: false, latencyMs: 0 }),
      ],
    );
    expect(metrics.dispatchFailedAttempts).toBe(2);
    expect(metrics.dispatchRejectedAttempts).toBe(1);
    expect(metrics.resultInvalidAttempts).toBe(1);
    expect(metrics.retryableAttempts).toBe(2);
    expect(metrics.averageLatencyMs).toBe(113); // round(450 / 4)
  });

  it('reports null latency with no attempts', () => {
    expect(computeQualityMetrics([], []).averageLatencyMs).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The UTILIZATION dimension
// ---------------------------------------------------------------------------

describe('computeUtilizationMetrics and deriveWindow', () => {
  it('derives the window from the included submissions', () => {
    const executions = [
      execution({ id: 'e1', submittedAt: '2027-01-01T00:00:00.000Z' }),
      execution({ id: 'e2', submittedAt: '2027-01-05T12:00:00.000Z' }),
      execution({ id: 'e3', submittedAt: '2027-01-03T06:00:00.000Z' }),
    ];
    const window = deriveWindow(executions, '2027-01-10T00:00:00.000Z');
    expect(window.windowFrom).toBe('2027-01-01T00:00:00.000Z');
    expect(window.windowTo).toBe('2027-01-05T12:00:00.000Z');
  });

  it('collapses to the evaluation instant when the agent was never submitted to', () => {
    const window = deriveWindow([], '2027-01-10T00:00:00.000Z');
    expect(window).toEqual({
      windowFrom: '2027-01-10T00:00:00.000Z',
      windowTo: '2027-01-10T00:00:00.000Z',
    });
    const metrics = computeUtilizationMetrics([], window.windowFrom, window.windowTo);
    expect(metrics.submissions).toBe(0);
    expect(metrics.windowDays).toBe(1);
    expect(metrics.submissionsPerDay).toBe(0);
    expect(metrics.firstSubmissionAt).toBeNull();
    expect(metrics.lastSubmissionAt).toBeNull();
  });

  it('counts distinct principals, active days and live share', () => {
    const metrics = computeUtilizationMetrics(
      [
        execution({ id: 'e1', submittedBy: 'p1', submittedAt: '2027-01-01T01:00:00.000Z', status: 'succeeded' }),
        execution({ id: 'e2', submittedBy: 'p1', submittedAt: '2027-01-01T09:00:00.000Z', status: 'queued' }),
        execution({ id: 'e3', submittedBy: 'p2', submittedAt: '2027-01-02T09:00:00.000Z', status: 'awaiting_approval' }),
        execution({ id: 'e4', submittedBy: 'p3', submittedAt: '2027-01-04T09:00:00.000Z', status: 'succeeded' }),
      ],
      '2027-01-01T01:00:00.000Z',
      '2027-01-04T09:00:00.000Z',
    );
    expect(metrics.submissions).toBe(4);
    expect(metrics.live).toBe(2);
    expect(metrics.distinctPrincipals).toBe(3);
    expect(metrics.distinctActiveDays).toBe(3);
    expect(metrics.windowDays).toBe(4);
    expect(metrics.submissionsPerDay).toBe(1);
    expect(metrics.firstSubmissionAt).toBe('2027-01-01T01:00:00.000Z');
    expect(metrics.lastSubmissionAt).toBe('2027-01-04T09:00:00.000Z');
  });

  it('never reports a zero-day window (the denominators stay total)', () => {
    const metrics = computeUtilizationMetrics(
      [execution({ id: 'e1', submittedAt: '2027-01-01T00:00:00.000Z' })],
      '2027-01-01T00:00:00.000Z',
      '2027-01-01T00:00:00.000Z',
    );
    expect(metrics.windowDays).toBe(1);
    expect(metrics.submissionsPerDay).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The SECURITY dimension
// ---------------------------------------------------------------------------

describe('computeSecurityMetrics', () => {
  it('reports a clean bill for a fully-exercised least-privilege grant', () => {
    const metrics = computeSecurityMetrics(
      ['observe', 'analyze'] as AgentPermissionScope[],
      [execution({ id: 'e1', requestedPermissions: ['observe', 'analyze'] })],
    );
    expect(metrics.overGrantedScopes).toEqual([]);
    expect(metrics.findings).toEqual([]);
    expect(metrics.approvalGated).toBe(0);
    expect(metrics.policyRefusals).toBe(0);
    expect(metrics.approvalRejections).toBe(0);
    expect(metrics.requestedScopeCounts).toEqual({ observe: 1, analyze: 1 });
  });

  it('flags over-granted scopes (least-privilege signal), sorted', () => {
    const metrics = computeSecurityMetrics(
      ['observe', 'analyze', 'recommend', 'ask'] as AgentPermissionScope[],
      [execution({ id: 'e1', requestedPermissions: ['analyze'] })],
    );
    expect(metrics.overGrantedScopes).toEqual(['ask', 'observe', 'recommend']);
    const overGranted = metrics.findings.filter((f) => f.code === 'over_granted_scope');
    expect(overGranted.map((f) => f.subject)).toEqual(['ask', 'observe', 'recommend']);
  });

  it('flags the highest §20 scope when granted', () => {
    const metrics = computeSecurityMetrics(
      ['observe', 'execute'] as AgentPermissionScope[],
      [execution({ id: 'e1', requestedPermissions: ['observe', 'execute'] })],
    );
    const executeFinding = metrics.findings.find((f) => f.code === 'execute_scope_granted');
    expect(executeFinding).toBeDefined();
    expect(executeFinding!.subject).toBe('execute');
    expect(metrics.overGrantedScopes).toEqual([]);
  });

  it('counts authority interactions from the recorded W009 evidence', () => {
    const metrics = computeSecurityMetrics(
      ['observe', 'execute'] as AgentPermissionScope[],
      [
        execution({
          id: 'e1',
          requestedPermissions: ['observe'],
          policy: { actionRequestId: 'r1', outcome: 'allowed', resolvedVia: 'built-in' },
          status: 'succeeded',
        }),
        execution({
          id: 'e2',
          requestedPermissions: ['execute'],
          policy: { actionRequestId: 'r2', outcome: 'approval_required', resolvedVia: 'kind' },
          status: 'refused',
          errorCode: 'approval_rejected',
        }),
        execution({
          id: 'e3',
          requestedPermissions: ['execute'],
          policy: { actionRequestId: 'r3', outcome: 'forbidden', resolvedVia: 'tenant-default' },
          status: 'refused',
          errorCode: 'execution_forbidden',
        }),
      ],
    );
    expect(metrics.approvalGated).toBe(1);
    expect(metrics.approvalRejections).toBe(1);
    expect(metrics.policyRefusals).toBe(1);
    expect(metrics.findings.map((f) => f.code)).toContain('approval_rejections_present');
    expect(metrics.findings.map((f) => f.code)).toContain('policy_refusals_present');
    expect(metrics.findings.map((f) => f.code)).toContain('execute_scope_granted');
  });
});

// ---------------------------------------------------------------------------
// The REPLACEMENT OPTIONS comparison
// ---------------------------------------------------------------------------

describe('compareReplacementCost', () => {
  it('classifies lower / equal / higher deterministically', () => {
    expect(compareReplacementCost(90, 'USD', 100, 'USD')).toEqual({
      costDeltaMinor: -10,
      costComparison: 'lower_cost',
    });
    expect(compareReplacementCost(100, 'USD', 100, 'USD')).toEqual({
      costDeltaMinor: 0,
      costComparison: 'equal_cost',
    });
    expect(compareReplacementCost(101, 'USD', 100, 'USD')).toEqual({
      costDeltaMinor: 1,
      costComparison: 'higher_cost',
    });
  });

  it('reports unknown when the option carries no estimate', () => {
    expect(compareReplacementCost(null, null, 100, 'USD')).toEqual({
      costDeltaMinor: null,
      costComparison: 'unknown',
    });
  });

  it('refuses cross-currency arithmetic (no exchange rate is owned here)', () => {
    expect(compareReplacementCost(90, 'EUR', 100, 'USD')).toEqual({
      costDeltaMinor: null,
      costComparison: 'unknown',
    });
    // A null currency defaults to the measured currency — comparable.
    expect(compareReplacementCost(90, null, 100, 'USD')).toEqual({
      costDeltaMinor: -10,
      costComparison: 'lower_cost',
    });
  });
});

// ---------------------------------------------------------------------------
// The lifecycle routing (policy)
// ---------------------------------------------------------------------------

describe('lifecycle policy', () => {
  it('anchors the §15 tail vocabulary', () => {
    expect(AGENT_LIFECYCLE_CHANGES).toEqual(['retain', 'modify', 'terminate']);
    expect(AGENT_REPLACEMENT_KINDS).toEqual([
      'retain',
      'modify',
      'train',
      'reassign',
      'hire',
      'automate',
      'recruit',
      'install',
      'eliminate',
    ]);
    expect(AGENT_DECISION_STATUSES).toEqual([
      'recorded',
      'awaiting_approval',
      'approved',
      'applied',
      'refused',
    ]);
  });

  it('gates only terminate through the authority matrix (§20 names termination)', () => {
    expect(isMatrixGated('terminate')).toBe(true);
    expect(isMatrixGated('retain')).toBe(false);
    expect(isMatrixGated('modify')).toBe(false);
    expect(AGENT_TERMINATION_ACTION_KIND).toBe('agent-termination');
    expect(AGENT_TERMINATION_AUTHORITY_LEVEL).toBe('EXECUTE');
  });

  it('maps gate outcomes onto the lifecycle deterministically', () => {
    expect(statusForGateOutcome('allowed')).toBe('approved');
    expect(statusForGateOutcome('approval_required')).toBe('awaiting_approval');
    expect(statusForGateOutcome('forbidden')).toBe('refused');
  });

  it('partitions terminal from live decision states', () => {
    expect(isTerminalDecisionStatus('recorded')).toBe(true);
    expect(isTerminalDecisionStatus('applied')).toBe(true);
    expect(isTerminalDecisionStatus('refused')).toBe(true);
    expect(isTerminalDecisionStatus('awaiting_approval')).toBe(false);
    expect(isTerminalDecisionStatus('approved')).toBe(false);
  });

  it('guards the vocabularies and the management claim', () => {
    expect(isAgentLifecycleChange('terminate')).toBe(true);
    expect(isAgentLifecycleChange('promote')).toBe(false);
    expect(isAgentReplacementKind('hire')).toBe(true);
    expect(isAgentReplacementKind('fire')).toBe(false);
    expect(isAgentDecisionStatus('applied')).toBe(true);
    expect(isAgentDecisionStatus('pending')).toBe(false);
    expect(canDecideAgentLifecycle([])).toBe(false);
    expect(canDecideAgentLifecycle(['agents:administer'])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The input guards (validation)
// ---------------------------------------------------------------------------

describe('validation', () => {
  const baseEvaluation = {
    agentId: '01234567-89ab-cdef-0123-456789abcdef',
    replacementOptions: [
      {
        kind: 'retain' as const,
        summary: 'Keep the triage agent as is.',
      },
    ],
  };

  it('accepts a minimal evaluation input', () => {
    const valid = validateRecordAgentEvaluationInput(baseEvaluation);
    expect(valid.agentId).toBe(baseEvaluation.agentId);
    expect(valid.replacementOptions).toHaveLength(1);
    expect(valid.replacementOptions[0]!).toEqual({
      kind: 'retain',
      summary: 'Keep the triage agent as is.',
      note: null,
      estimatedCostMinor: null,
      estimatedCostCurrency: null,
      estimatedWeeks: null,
      recommended: false,
    });
  });

  it('rejects unknown keys (audit fields are not caller-forgeable)', () => {
    expect(() =>
      validateRecordAgentEvaluationInput({
        ...baseEvaluation,
        status: 'recorded',
        recordedAt: '2027-01-01T00:00:00.000Z',
      } as unknown as RecordAgentEvaluationInput),
    ).toThrow(AgentEvaluationError);
  });

  it('rejects an empty replacement-option list (the work item measures them)', () => {
    expect(() =>
      validateRecordAgentEvaluationInput({ ...baseEvaluation, replacementOptions: [] }),
    ).toThrow(/1\.\.9/);
  });

  it('rejects duplicate option kinds', () => {
    expect(() =>
      validateRecordAgentEvaluationInput({
        ...baseEvaluation,
        replacementOptions: [
          { kind: 'retain', summary: 'a' },
          { kind: 'retain', summary: 'b' },
        ],
      }),
    ).toThrow(/distinct/);
  });

  it('rejects two recommended options', () => {
    expect(() =>
      validateRecordAgentEvaluationInput({
        ...baseEvaluation,
        replacementOptions: [
          { kind: 'retain', summary: 'a', recommended: true },
          { kind: 'hire', summary: 'b', recommended: true },
        ],
      }),
    ).toThrow(/at most one/);
  });

  it('rejects malformed money, currency and weeks', () => {
    expect(() =>
      validateRecordAgentEvaluationInput({
        ...baseEvaluation,
        replacementOptions: [{ kind: 'hire', summary: 'a', estimatedCostMinor: -5 }],
      }),
    ).toThrow(/estimatedCostMinor/);
    expect(() =>
      validateRecordAgentEvaluationInput({
        ...baseEvaluation,
        replacementOptions: [{ kind: 'hire', summary: 'a', estimatedCostMinor: 1.5 }],
      }),
    ).toThrow(/estimatedCostMinor/);
    expect(() =>
      validateRecordAgentEvaluationInput({
        ...baseEvaluation,
        replacementOptions: [{ kind: 'hire', summary: 'a', estimatedCostCurrency: 'usd' }],
      }),
    ).toThrow(/ISO 4217/);
    expect(() =>
      validateRecordAgentEvaluationInput({
        ...baseEvaluation,
        replacementOptions: [{ kind: 'hire', summary: 'a', estimatedWeeks: 0 }],
      }),
    ).toThrow(/estimatedWeeks/);
  });

  it('rejects a malformed agent id as uniformly not-found', () => {
    expect(() =>
      validateRecordAgentEvaluationInput({ ...baseEvaluation, agentId: 'not-a-uuid' }),
    ).toThrow(AgentEvaluationError);
    try {
      validateRecordAgentEvaluationInput({ ...baseEvaluation, agentId: 'not-a-uuid' });
      expect.unreachable('must throw');
    } catch (error) {
      expect((error as AgentEvaluationError).code).toBe('agent_not_found');
    }
  });

  const baseDecision = {
    evaluationId: '01234567-89ab-cdef-0123-456789abcdef',
    change: 'terminate' as const,
    rationale: 'Sustained missed outcomes and falling utilization.',
  };

  it('accepts a minimal terminate decision', () => {
    const valid = validateDecideAgentLifecycleInput(baseDecision);
    expect(valid.change).toBe('terminate');
    expect(valid.modificationSummary).toBeNull();
    expect(valid.replacementOptionId).toBeNull();
  });

  it('requires a modification summary exactly on modify decisions', () => {
    expect(() =>
      validateDecideAgentLifecycleInput({ ...baseDecision, change: 'modify' }),
    ).toThrow(/modificationSummary is required/);
    expect(() =>
      validateDecideAgentLifecycleInput({
        ...baseDecision,
        change: 'retain',
        modificationSummary: 'narrow the permissions',
      }),
    ).toThrow(/only meaningful for modify/);
    const valid = validateDecideAgentLifecycleInput({
      ...baseDecision,
      change: 'modify',
      modificationSummary: 'Narrow the grant to observe+analyze.',
    });
    expect(valid.modificationSummary).toBe('Narrow the grant to observe+analyze.');
  });

  it('rejects replacement options on non-terminate decisions', () => {
    expect(() =>
      validateDecideAgentLifecycleInput({
        ...baseDecision,
        change: 'retain',
        replacementOptionId: '01234567-89ab-cdef-0123-456789abcdee',
      }),
    ).toThrow(/only meaningful for terminate/);
  });

  it('rejects unknown decision keys and malformed shapes', () => {
    expect(() =>
      validateDecideAgentLifecycleInput({
        ...baseDecision,
        status: 'applied',
      } as unknown as DecideAgentLifecycleInput),
    ).toThrow(AgentEvaluationError);
    expect(() => validateDecideAgentLifecycleInput({ ...baseDecision, rationale: '' })).toThrow(
      /rationale/,
    );
    expect(() =>
      validateDecideAgentLifecycleInput({
        ...baseDecision,
        change: 'promote',
      } as unknown as DecideAgentLifecycleInput),
    ).toThrow(/change/);
  });
});
