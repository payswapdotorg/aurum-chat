// Integration tests for the agent-evaluation module against the embedded
// PostgreSQL (PGlite, `:memory:`) through the db port. Covers the W024
// acceptance: "Measure outcome, cost, quality, utilization, security and
// replacement options; lifecycle changes follow policy."
//
//  * measurement — recordAgentEvaluation computes all six dimensions
//    from CONTRACT state (agents executions/attempts, learning
//    outcomes), never from caller input: outcome counts and
//    expected-versus-realized sums, integer-minor-unit cost totals and
//    usage, terminal distribution/success rate/failure classifications,
//    submission utilization over the derived window, and the
//    granted-versus-requested security posture with deterministic
//    findings; replacement options are compared against the MEASURED
//    cost deterministically (lower/equal/higher/unknown);
//  * policy — the §15 tail: retain/modify decisions are recorded
//    evidence behind the 'agents:administer' claim; terminate decisions
//    pass through the W009 authority matrix (kind 'agent-termination',
//    level EXECUTE): the built-in default gates them behind a human
//    approval (awaiting_approval → decideApproval → settle → applied,
//    with the agent definition disabled through the agents contract), a
//    tenant policy may allow (approved → settle → applied) or forbid
//    (terminal refused), and a human may reject (terminal refused, the
//    agent stays active);
//  * evidence linkage — decisions cite a measured evaluation (foreign
//    ids uniformly not-found) and may cite exactly one of THAT
//    evaluation's replacement options;
//  * tenant isolation — every operation is tenant-scoped; another
//    tenant's agents, evaluations and decisions are indistinguishable
//    from missing ones;
//  * storage — evaluations and replacement options are append-only
//    (UPDATE/DELETE rejected at the storage level); decisions freeze
//    their substantive content and move only their lifecycle state.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import * as evaluationContract from '../contract';
import * as agentsContract from '@/modules/agents/contract';
import * as actionsContract from '@/modules/actions/contract';
import * as learningContract from '@/modules/learning/contract';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { AgentEvaluationError } from '../errors';
import { setAgentTransport } from '@/modules/agents/contract';
import type {
  AgentRuntimeTransport,
  AgentRuntimeTransportReceipt,
  AgentRuntimeTransportRequest,
  RegisterAgentInput,
} from '@/modules/agents/contract';
import { runMigrations } from '../../../../scripts/migrate';

const {
  decideAgentLifecycle,
  getAgentEvaluation,
  getAgentLifecycleDecision,
  listAgentEvaluations,
  listAgentLifecycleDecisions,
  recordAgentEvaluation,
  settleAgentLifecycleDecision,
} = evaluationContract;

const {
  getAgent,
  runAgentExecution,
  submitAgentExecution,
  cancelAgentExecution,
} = agentsContract;

/** Registers an agent and unwraps the definition (the agents test's helper). */
async function register(ctx: TenantContext, input: RegisterAgentInput) {
  const result = await agentsContract.registerAgent(ctx, input);
  return result.agent;
}

const { decideApproval, getActionRequest, setAuthorityPolicy } = actionsContract;
const { defineOutcome, recordMeasurement, settleOutcome } = learningContract;

// Dedicated tenants per group so count/order assertions stay deterministic.
const tenantMeasure = newId();
const tenantTerminate = newId();
const tenantAllow = newId();
const tenantForbid = newId();
const tenantReject = newId();
const tenantDecisions = newId();
const tenantIsolation = newId();
const tenantStorage = newId();
const tenantOther = newId();

function member(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: [] };
}

function agentsAdmin(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: ['agents:administer'] };
}

function actionsAdmin(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: ['actions:administer', 'agents:administer'] };
}

function approver(tenantId: string): TenantContext {
  // A DIFFERENT principal with the actions approval claim (separation of duties).
  return { tenantId, principalId: newId(), authority: ['actions:approve'] };
}

async function expectCode(
  code: AgentEvaluationError['code'],
  fn: () => Promise<unknown>,
): Promise<void> {
  try {
    await fn();
    throw new Error(`expected AgentEvaluationError('${code}') but the call succeeded`);
  } catch (error) {
    expect(error).toBeInstanceOf(AgentEvaluationError);
    expect((error as AgentEvaluationError).code).toBe(code);
  }
}

// ---------------------------------------------------------------------------
// A recording fake transport that speaks every runtime dialect
// ---------------------------------------------------------------------------

interface FakeOutcome {
  output?: unknown;
  summary?: string;
  inputTokens?: number;
  outputTokens?: number;
  operations?: number;
}

class FakeAgentTransport implements AgentRuntimeTransport {
  readonly requests: AgentRuntimeTransportRequest[] = [];
  private outcome: FakeOutcome = {};
  private failuresLeft = 0;
  private failureStatus: 'rejected' | 'failed' = 'failed';
  private static counter = 0;

  respondWith(outcome: FakeOutcome): void {
    this.outcome = outcome;
  }

  /** The next `count` dispatches fail (transient by default). */
  failNext(count: number, status: 'rejected' | 'failed' = 'failed'): void {
    this.failuresLeft = count;
    this.failureStatus = status;
  }

  async send(request: AgentRuntimeTransportRequest): Promise<AgentRuntimeTransportReceipt> {
    this.requests.push(request);
    if (this.failuresLeft > 0) {
      this.failuresLeft -= 1;
      return {
        status: this.failureStatus,
        payload: null,
        providerTaskId: null,
        detail: `simulated ${this.failureStatus === 'failed' ? 'transient failure' : 'refusal'}`,
      };
    }
    FakeAgentTransport.counter += 1;
    const taskId = `fake-${String(FakeAgentTransport.counter).padStart(6, '0')}`;
    return {
      status: 'delivered',
      payload: this.payloadFor(request.provider, taskId),
      providerTaskId: taskId,
      detail: null,
    };
  }

  /** Builds a runtime-NATIVE payload for the adapter to parse (dialect realism). */
  private payloadFor(provider: string, taskId: string): unknown {
    const output = this.outcome.output ?? { triaged: true };
    const summary = this.outcome.summary ?? null;
    const inputTokens = this.outcome.inputTokens ?? 1200;
    const outputTokens = this.outcome.outputTokens ?? 800;
    const operations = this.outcome.operations ?? 3;
    switch (provider) {
      case 'openai-assistants':
        return {
          id: `run_${taskId}`,
          status: 'completed',
          output: [
            {
              type: 'message',
              content: [
                { type: 'output_text', text: typeof output === 'string' ? output : JSON.stringify(output) },
              ],
            },
          ],
          usage: { input_tokens: inputTokens, output_tokens: outputTokens },
        };
      case 'langgraph':
        return {
          run_id: `lg_${taskId}`,
          output: { result: output, summary },
          usage: { input_tokens: inputTokens, output_tokens: outputTokens, steps: operations },
        };
      default:
        return {
          id: `sk_${taskId}`,
          output,
          summary,
          usage: { inputTokens, outputTokens, invocations: operations },
        };
    }
  }
}

let transport: FakeAgentTransport;

beforeAll(async () => {
  await runMigrations(getDb());
});

afterAll(async () => {
  setAgentTransport(null);
  await closeDb();
});

beforeEach(() => {
  transport = new FakeAgentTransport();
  setAgentTransport(transport);
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ANALYST: RegisterAgentInput = {
  slug: 'triage-analyst',
  displayName: 'Triage Analyst',
  role: 'conversation triage',
  description: 'Triages inbound conversations and drafts replies.',
  provider: 'openai-assistants',
  instructions: 'Triage the conversation and propose a reply.',
  permissions: ['observe', 'analyze', 'recommend'],
  runtimeConfig: { assistantId: 'asst_triage' },
};

const OPERATOR: RegisterAgentInput = {
  ...ANALYST,
  slug: 'reply-operator',
  displayName: 'Reply Operator',
  permissions: ['observe', 'execute'],
  runtimeConfig: { assistantId: 'asst_operator' },
};

const TASK = { kind: 'triage', conversationId: 'c-1' };

/** Records one settled (met/exceeded/missed) outcome tied to an agent. */
async function settledOutcome(
  ctx: TenantContext,
  agentId: string,
  metricName: string,
  expected: number,
  realized: number,
): Promise<void> {
  const outcome = await defineOutcome(ctx, {
    subject: { kind: 'agent', id: agentId, label: 'the agent under evaluation' },
    metricName,
    metricUnit: 'tickets',
    direction: 'at_least',
    baseline: 10,
    expected,
    actor: { kind: 'system', label: 'integration-test' },
  });
  const measurement = await recordMeasurement(ctx, {
    outcomeId: outcome.id,
    value: realized,
    actor: { kind: 'system', label: 'integration-test' },
  });
  await settleOutcome(ctx, {
    outcomeId: outcome.id,
    measurementId: measurement.id,
    actor: { kind: 'system', label: 'integration-test' },
  });
}

// ---------------------------------------------------------------------------
// The measurement
// ---------------------------------------------------------------------------

describe('agent-evaluation service — the six measured dimensions', () => {
  it('measures outcome, cost, quality, utilization, security and replacement options from contract state', async () => {
    const admin = agentsAdmin(tenantMeasure);
    const analyst = await register(admin, ANALYST);
    const submitterA = member(tenantMeasure);
    const submitterB = member(tenantMeasure);

    // --- learning outcomes (W040): two settled, one open.
    await settledOutcome(submitterA, analyst.id, 'tickets triaged per week', 20, 25); // exceeded
    await settledOutcome(submitterA, analyst.id, 'reply quality score', 30, 21); // missed
    await defineOutcome(submitterA, {
      subject: { kind: 'agent', id: analyst.id },
      metricName: 'escalation rate',
      metricUnit: 'percent',
      direction: 'at_most',
      baseline: 12,
      expected: 8,
      actor: { kind: 'system', label: 'integration-test' },
    });

    // --- agents executions (W021): two succeeded, one failed after two
    // transient attempts, one cancelled — with readable money (1100
    // minor per completed attempt: 1.2M in / 0.8M out at list prices).
    transport.respondWith({ inputTokens: 1_200_000, outputTokens: 800_000, operations: 3 });

    const first = await submitAgentExecution(submitterA, {
      agentId: analyst.id,
      task: TASK,
      requestedPermissions: ['observe'],
    });
    const second = await submitAgentExecution(submitterB, {
      agentId: analyst.id,
      task: TASK,
      requestedPermissions: ['analyze'],
    });
    expect((await runAgentExecution(submitterA, { executionId: first.id })).status).toBe('succeeded');
    expect((await runAgentExecution(submitterB, { executionId: second.id })).status).toBe('succeeded');

    const flaky = await submitAgentExecution(submitterA, {
      agentId: analyst.id,
      task: TASK,
      requestedPermissions: ['observe'],
      maxAttempts: 2,
    });
    transport.failNext(2);
    expect((await runAgentExecution(submitterA, { executionId: flaky.id })).status).toBe('queued');
    expect((await runAgentExecution(submitterA, { executionId: flaky.id })).status).toBe('failed');

    const cancelled = await submitAgentExecution(submitterA, {
      agentId: analyst.id,
      task: TASK,
      requestedPermissions: ['observe'],
    });
    expect(
      (await cancelAgentExecution(submitterA, { executionId: cancelled.id, reason: 'not needed' }))
        .status,
    ).toBe('cancelled');

    // --- the measurement.
    const evaluation = await recordAgentEvaluation(submitterA, {
      agentId: analyst.id,
      replacementOptions: [
        {
          kind: 'retain',
          summary: 'Keep the triage agent as is.',
          estimatedCostMinor: 2200,
        },
        {
          kind: 'hire',
          summary: 'Hire a part-time human triager.',
          note: 'Requires onboarding.',
          estimatedCostMinor: 5000,
          estimatedCostCurrency: 'USD',
          estimatedWeeks: 8,
        },
        {
          kind: 'automate',
          summary: 'Install the marketplace triage extension.',
          estimatedCostMinor: 900,
          recommended: true,
        },
        {
          kind: 'eliminate',
          summary: 'Retire the capability outright (no replacement).',
        },
      ],
    });

    // Decision-time agent snapshot.
    expect(evaluation.agent).toEqual({
      slug: 'triage-analyst',
      role: 'conversation triage',
      provider: 'openai-assistants',
      status: 'active',
      permissions: ['observe', 'analyze', 'recommend'],
    });

    // OUTCOME: two settled (one exceeded, one missed), one open.
    expect(evaluation.outcome).toEqual({
      outcomesTotal: 3,
      open: 1,
      settled: 2,
      abandoned: 0,
      met: 0,
      exceeded: 1,
      missed: 1,
      settledExpectedTotal: 50,
      settledRealizedTotal: 46,
      netVarianceVsExpected: -4,
    });

    // COST: 2200 minor over two succeeded executions; four attempts
    // total (two completed, two transient failures); usage sums over
    // the completed attempts only (the openai-assistants dialect
    // reports tokens but no operations — an honest null).
    expect(evaluation.cost).toEqual({
      executionsIncluded: 4,
      executionsTruncated: false,
      totalCostMinor: 2200,
      costCurrency: 'USD',
      succeededCostMinor: 2200,
      costPerSucceededMinor: 1100,
      attemptsIncluded: 4,
      inputTokensTotal: 2_400_000,
      outputTokensTotal: 1_600_000,
      operationsTotal: null,
    });

    // QUALITY: 2 succeeded / 1 failed / 1 cancelled; success rate over
    // terminals; both transient failures classified and unpriced.
    expect(evaluation.quality).toEqual({
      succeeded: 2,
      failed: 1,
      refused: 0,
      cancelled: 1,
      terminalCount: 4,
      successRate: 0.5,
      dispatchFailedAttempts: 2,
      dispatchRejectedAttempts: 0,
      resultInvalidAttempts: 0,
      retryableAttempts: 2,
      averageLatencyMs: expect.any(Number),
    });
    expect(evaluation.quality.averageLatencyMs).toBeGreaterThanOrEqual(0);

    // UTILIZATION: four submissions from two principals on one day.
    expect(evaluation.utilization.submissions).toBe(4);
    expect(evaluation.utilization.live).toBe(0);
    expect(evaluation.utilization.distinctPrincipals).toBe(2);
    expect(evaluation.utilization.distinctActiveDays).toBe(1);
    expect(evaluation.utilization.windowDays).toBe(1);
    expect(evaluation.utilization.submissionsPerDay).toBe(4);
    expect(evaluation.utilization.firstSubmissionAt).toBe(evaluation.windowFrom);
    expect(evaluation.utilization.lastSubmissionAt).toBe(evaluation.windowTo);
    expect(new Date(evaluation.windowFrom).getTime()).toBeLessThanOrEqual(
      new Date(evaluation.windowTo).getTime(),
    );

    // SECURITY: 'recommend' granted but never requested; no authority
    // interactions on this agent.
    expect(evaluation.security.grantedPermissions).toEqual(['observe', 'analyze', 'recommend']);
    expect(evaluation.security.requestedScopeCounts).toEqual({ observe: 3, analyze: 1 });
    expect(evaluation.security.overGrantedScopes).toEqual(['recommend']);
    expect(evaluation.security.approvalGated).toBe(0);
    expect(evaluation.security.policyRefusals).toBe(0);
    expect(evaluation.security.approvalRejections).toBe(0);
    expect(evaluation.security.findings.map((f) => f.code)).toEqual(['over_granted_scope']);
    expect(evaluation.security.findings[0]!.subject).toBe('recommend');

    // BASIS.
    expect(evaluation.basis).toEqual({
      executionsIncluded: 4,
      attemptsIncluded: 4,
      outcomesIncluded: 3,
      executionsTruncated: false,
      outcomesTruncated: false,
    });

    // REPLACEMENT OPTIONS: the deterministic comparison against the
    // MEASURED window cost (2200 minor).
    const byKind = new Map(evaluation.replacementOptions.map((o) => [o.kind, o]));
    expect(byKind.get('retain')).toMatchObject({
      estimatedCostMinor: 2200,
      costDeltaMinor: 0,
      costComparison: 'equal_cost',
      recommended: false,
    });
    expect(byKind.get('hire')).toMatchObject({
      estimatedCostMinor: 5000,
      estimatedWeeks: 8,
      costDeltaMinor: 2800,
      costComparison: 'higher_cost',
      recommended: false,
    });
    expect(byKind.get('automate')).toMatchObject({
      estimatedCostMinor: 900,
      costDeltaMinor: -1300,
      costComparison: 'lower_cost',
      recommended: true,
    });
    expect(byKind.get('eliminate')).toMatchObject({
      estimatedCostMinor: null,
      costDeltaMinor: null,
      costComparison: 'unknown',
    });
    expect(evaluation.replacementOptions.every((o) => o.evaluationId === evaluation.id)).toBe(true);

    // The measurement is retrievable byte-stable and listable.
    const reread = await getAgentEvaluation(submitterA, { evaluationId: evaluation.id });
    expect(reread).toEqual(evaluation);
    const listed = await listAgentEvaluations(submitterA, { agentId: analyst.id });
    expect(listed).toHaveLength(1);
    expect(listed[0]!.id).toBe(evaluation.id);
  });

  it('measures the security posture of a high-privilege agent from the recorded W009 evidence', async () => {
    const admin = agentsAdmin(tenantMeasure);
    const operator = await register(admin, { ...OPERATOR });
    const submitting = member(tenantMeasure);
    const approverCtx = approver(tenantMeasure);

    // An EXECUTE-level submission: the built-in default matrix gates it.
    const gated = await submitAgentExecution(submitting, {
      agentId: operator.id,
      task: TASK,
      requestedPermissions: ['execute'],
    });
    expect(gated.status).toBe('awaiting_approval');
    expect(gated.policy.outcome).toBe('approval_required');

    // A human rejects it; the pump resolves the refusal.
    await decideApproval(approverCtx, {
      requestId: gated.policy.actionRequestId,
      decision: 'reject',
      note: 'not authorized for this conversation',
    });
    expect((await runAgentExecution(submitting, { executionId: gated.id })).status).toBe('refused');

    const evaluation = await recordAgentEvaluation(submitting, {
      agentId: operator.id,
      replacementOptions: [{ kind: 'retain', summary: 'Keep, but narrow the grant.' }],
    });

    expect(evaluation.security.grantedPermissions).toEqual(['observe', 'execute']);
    expect(evaluation.security.requestedScopeCounts).toEqual({ execute: 1 });
    expect(evaluation.security.overGrantedScopes).toEqual(['observe']);
    expect(evaluation.security.approvalGated).toBe(1);
    expect(evaluation.security.approvalRejections).toBe(1);
    expect(evaluation.security.policyRefusals).toBe(0);
    expect(evaluation.security.findings.map((f) => f.code)).toEqual([
      'over_granted_scope',
      'execute_scope_granted',
      'approval_rejections_present',
    ]);

    // An honest no-basis: nothing dispatched, so no cost or latency.
    expect(evaluation.cost.totalCostMinor).toBe(0);
    expect(evaluation.cost.attemptsIncluded).toBe(0);
    expect(evaluation.cost.costPerSucceededMinor).toBeNull();
    expect(evaluation.quality.successRate).toBe(0);
    expect(evaluation.quality.averageLatencyMs).toBeNull();
    expect(evaluation.quality.refused).toBe(1);
    expect(evaluation.utilization.submissions).toBe(1);
    expect(evaluation.outcome.outcomesTotal).toBe(0);
  });

  it('rejects malformed and unmeasurable evaluation inputs', async () => {
    const admin = agentsAdmin(tenantMeasure);
    const analyst = await register(admin, { ...ANALYST, slug: 'input-guard-agent' });
    const submitting = member(tenantMeasure);

    await expectCode('agent_not_found', () =>
      recordAgentEvaluation(submitting, {
        agentId: 'not-a-uuid',
        replacementOptions: [{ kind: 'retain', summary: 'x' }],
      }),
    );
    await expectCode('agent_not_found', () =>
      recordAgentEvaluation(submitting, {
        agentId: newId(),
        replacementOptions: [{ kind: 'retain', summary: 'x' }],
      }),
    );
    await expectCode('invalid_evaluation_input', () =>
      recordAgentEvaluation(submitting, {
        agentId: analyst.id,
        replacementOptions: [],
      }),
    );
    await expectCode('invalid_evaluation_input', () =>
      recordAgentEvaluation(submitting, {
        agentId: analyst.id,
        replacementOptions: [
          { kind: 'retain', summary: 'a' },
          { kind: 'retain', summary: 'b' },
        ],
      }),
    );
    await expectCode('invalid_evaluation_input', () =>
      recordAgentEvaluation(submitting, {
        agentId: analyst.id,
        // @ts-expect-error deliberately forging an audit field
        recordedAt: '2027-01-01T00:00:00.000Z',
        replacementOptions: [{ kind: 'retain', summary: 'a' }],
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Termination follows policy (the W009 authority matrix)
// ---------------------------------------------------------------------------

describe('agent-evaluation service — termination follows policy', () => {
  it('gates termination behind a human approval by default, then applies it through the agents contract', async () => {
    const admin = agentsAdmin(tenantTerminate);
    const agent = await register(admin, { ...ANALYST, slug: 'gate-default-agent' });
    const submitting = member(tenantTerminate);
    const approverCtx = approver(tenantTerminate);

    const evaluation = await recordAgentEvaluation(submitting, {
      agentId: agent.id,
      replacementOptions: [
        { kind: 'eliminate', summary: 'The triage need has been retired.' },
        { kind: 'automate', summary: 'Move to an extension.', recommended: true },
      ],
    });
    const replacement = evaluation.replacementOptions.find((o) => o.kind === 'automate')!;

    // Deciding the workforce is a management action.
    await expectCode('forbidden', () =>
      decideAgentLifecycle(submitting, {
        evaluationId: evaluation.id,
        change: 'terminate',
        rationale: 'Unused and over-granted.',
      }),
    );

    // A member cannot settle either (applying mutates the definition).
    const decided = await decideAgentLifecycle(admin, {
      evaluationId: evaluation.id,
      change: 'terminate',
      rationale: 'Unused and over-granted.',
      replacementOptionId: replacement.id,
    });
    expect(decided.status).toBe('awaiting_approval');
    expect(decided.change).toBe('terminate');
    expect(decided.agentSlug).toBe('gate-default-agent');
    expect(decided.replacementOptionId).toBe(replacement.id);
    expect(decided.policy).toMatchObject({
      policyOutcome: 'approval_required',
      policyResolvedVia: 'built-in',
      submittedBy: admin.principalId,
      decidedBy: null,
      decidedByPrincipal: null,
      decidedAt: null,
    });

    // The linked action request is the §20 consequential action.
    const request = await getActionRequest(admin, {
      requestId: decided.policy!.actionRequestId,
    });
    expect(request.actionKind).toBe('agent-termination');
    expect(request.authorityLevel).toBe('EXECUTE');
    expect(request.status).toBe('pending');

    // Settling while the gate holds is a no-op; the agent stays active.
    await expectCode('forbidden', () =>
      settleAgentLifecycleDecision(approverCtx, { decisionId: decided.id }),
    );
    const stillWaiting = await settleAgentLifecycleDecision(admin, { decisionId: decided.id });
    expect(stillWaiting.status).toBe('awaiting_approval');
    expect((await getAgent(admin, { agentId: agent.id })).status).toBe('active');

    // A human approves; the settle pump applies the termination.
    await decideApproval(approverCtx, {
      requestId: decided.policy!.actionRequestId,
      decision: 'approve',
    });
    const applied = await settleAgentLifecycleDecision(admin, { decisionId: decided.id });
    expect(applied.status).toBe('applied');
    expect(applied.policy).toMatchObject({
      decidedBy: 'principal',
      decidedByPrincipal: approverCtx.principalId,
    });
    expect(applied.appliedAt).not.toBeNull();
    expect(applied.appliedByPrincipal).toBe(admin.principalId);

    // The applied effect: the definition is disabled through the agents
    // contract, and the disable is enforced by the gateway.
    const disabled = await getAgent(admin, { agentId: agent.id });
    expect(disabled.status).toBe('disabled');
    await expect(
      submitAgentExecution(member(tenantTerminate), {
        agentId: agent.id,
        task: TASK,
        requestedPermissions: ['observe'],
      }),
    ).rejects.toThrow(/disabled/);

    // Settling again is a read (idempotent).
    const again = await settleAgentLifecycleDecision(admin, { decisionId: decided.id });
    expect(again).toEqual(applied);
  });

  it('approves immediately when tenant policy explicitly allows, and applies on settle', async () => {
    const policy = actionsAdmin(tenantAllow);
    const agent = await register(policy, { ...ANALYST, slug: 'gate-allowed-agent' });
    const submitting = member(tenantAllow);

    // The tenant explicitly allows EXECUTE of 'agent-termination'.
    await setAuthorityPolicy(policy, {
      actionKind: 'agent-termination',
      approvalLevels: [],
      forbiddenLevels: [],
      note: 'agent lifecycle is administered directly',
    });

    const evaluation = await recordAgentEvaluation(submitting, {
      agentId: agent.id,
      replacementOptions: [{ kind: 'retain', summary: 'Baseline.' }],
    });
    const decided = await decideAgentLifecycle(policy, {
      evaluationId: evaluation.id,
      change: 'terminate',
      rationale: 'Policy-allowed termination.',
    });
    expect(decided.status).toBe('approved');
    expect(decided.policy).toMatchObject({
      policyOutcome: 'allowed',
      policyResolvedVia: 'kind',
      decidedBy: 'policy',
      decidedByPrincipal: null,
    });
    // Not yet applied — the settle step owns the application.
    expect((await getAgent(policy, { agentId: agent.id })).status).toBe('active');

    const applied = await settleAgentLifecycleDecision(policy, { decisionId: decided.id });
    expect(applied.status).toBe('applied');
    expect(applied.policy!.decidedBy).toBe('policy');
    expect((await getAgent(policy, { agentId: agent.id })).status).toBe('disabled');
  });

  it('refuses terminations the tenant policy forbids, and records the refusal as evidence', async () => {
    const policy = actionsAdmin(tenantForbid);
    const agent = await register(policy, { ...ANALYST, slug: 'gate-forbidden-agent' });
    const submitting = member(tenantForbid);

    await setAuthorityPolicy(policy, {
      actionKind: 'agent-termination',
      forbiddenLevels: ['EXECUTE'],
      note: 'no agent may be terminated without an architect change',
    });

    const evaluation = await recordAgentEvaluation(submitting, {
      agentId: agent.id,
      replacementOptions: [{ kind: 'retain', summary: 'Baseline.' }],
    });
    const refused = await decideAgentLifecycle(policy, {
      evaluationId: evaluation.id,
      change: 'terminate',
      rationale: 'Trying anyway.',
    });
    expect(refused.status).toBe('refused');
    expect(refused.policy).toMatchObject({
      policyOutcome: 'forbidden',
      policyResolvedVia: 'kind',
      decidedBy: 'policy',
    });
    expect(refused.appliedAt).toBeNull();

    // The agent stays active, and settling the refusal is a read.
    expect((await getAgent(policy, { agentId: agent.id })).status).toBe('active');
    const settled = await settleAgentLifecycleDecision(policy, { decisionId: refused.id });
    expect(settled).toEqual(refused);
    expect((await getAgent(policy, { agentId: agent.id })).status).toBe('active');
  });

  it('records a human rejection as terminal evidence; the agent stays active', async () => {
    const admin = agentsAdmin(tenantReject);
    const agent = await register(admin, { ...ANALYST, slug: 'gate-rejected-agent' });
    const submitting = member(tenantReject);
    const approverCtx = approver(tenantReject);

    const evaluation = await recordAgentEvaluation(submitting, {
      agentId: agent.id,
      replacementOptions: [{ kind: 'retain', summary: 'Baseline.' }],
    });
    const decided = await decideAgentLifecycle(admin, {
      evaluationId: evaluation.id,
      change: 'terminate',
      rationale: 'Proposing termination for the review.',
    });
    expect(decided.status).toBe('awaiting_approval');

    await decideApproval(approverCtx, {
      requestId: decided.policy!.actionRequestId,
      decision: 'reject',
      note: 'the measured outcomes do not justify it',
    });
    const refused = await settleAgentLifecycleDecision(admin, { decisionId: decided.id });
    expect(refused.status).toBe('refused');
    expect(refused.policy).toMatchObject({
      decidedBy: 'principal',
      decidedByPrincipal: approverCtx.principalId,
    });
    expect(refused.appliedAt).toBeNull();
    expect((await getAgent(admin, { agentId: agent.id })).status).toBe('active');
  });
});

// ---------------------------------------------------------------------------
// Retain / modify decisions and the evidence linkage
// ---------------------------------------------------------------------------

describe('agent-evaluation service — retain, modify and evidence linkage', () => {
  it('records retain/modify decisions as evidence behind the management claim', async () => {
    const admin = agentsAdmin(tenantDecisions);
    const agent = await register(admin, { ...ANALYST, slug: 'decision-agent' });
    const submitting = member(tenantDecisions);

    const evaluation = await recordAgentEvaluation(submitting, {
      agentId: agent.id,
      replacementOptions: [
        { kind: 'retain', summary: 'Keep as is.', recommended: true },
        { kind: 'modify', summary: 'Narrow the permission grant.' },
      ],
    });

    // Claim-gated.
    await expectCode('forbidden', () =>
      decideAgentLifecycle(submitting, {
        evaluationId: evaluation.id,
        change: 'retain',
        rationale: 'Steady state.',
      }),
    );

    const retained = await decideAgentLifecycle(admin, {
      evaluationId: evaluation.id,
      change: 'retain',
      rationale: 'Meets expectations at acceptable cost.',
      note: 'Reviewed quarterly.',
    });
    expect(retained.status).toBe('recorded');
    expect(retained.policy).toBeNull();
    expect(retained.appliedAt).toBeNull();
    expect(retained.modificationSummary).toBeNull();

    // A modify decision requires its summary.
    await expectCode('invalid_decision_input', () =>
      decideAgentLifecycle(admin, {
        evaluationId: evaluation.id,
        change: 'modify',
        rationale: 'Narrow the grant.',
      }),
    );
    const modified = await decideAgentLifecycle(admin, {
      evaluationId: evaluation.id,
      change: 'modify',
      rationale: 'The security evaluation flagged an over-granted scope.',
      modificationSummary: "Drop 'recommend' from the grant; the agent never uses it.",
    });
    expect(modified.status).toBe('recorded');
    expect(modified.modificationSummary).toContain('recommend');

    // Reads and filters.
    const listed = await listAgentLifecycleDecisions(admin, { agentId: agent.id });
    expect(listed).toHaveLength(2);
    const retainOnly = await listAgentLifecycleDecisions(admin, { change: 'retain' });
    expect(retainOnly.every((d) => d.change === 'retain')).toBe(true);
    const recordedOnly = await listAgentLifecycleDecisions(admin, { status: 'recorded' });
    expect(recordedOnly).toHaveLength(2);
    const reread = await getAgentLifecycleDecision(admin, { decisionId: retained.id });
    expect(reread).toEqual(retained);
  });

  it('links termination decisions to the cited evaluation and its own replacement options only', async () => {
    const admin = agentsAdmin(tenantDecisions);
    const agentA = await register(admin, { ...ANALYST, slug: 'linked-agent-a' });
    const agentB = await register(admin, { ...ANALYST, slug: 'linked-agent-b' });
    const submitting = member(tenantDecisions);

    const evaluationA = await recordAgentEvaluation(submitting, {
      agentId: agentA.id,
      replacementOptions: [{ kind: 'eliminate', summary: 'Retire the capability.' }],
    });
    const evaluationB = await recordAgentEvaluation(submitting, {
      agentId: agentB.id,
      replacementOptions: [{ kind: 'recruit', summary: 'Replace with a cheaper runtime agent.' }],
    });

    // A foreign evaluation is uniformly not-found.
    await expectCode('evaluation_not_found', () =>
      decideAgentLifecycle(admin, {
        evaluationId: newId(),
        change: 'terminate',
        rationale: 'x',
      }),
    );

    // A replacement option of ANOTHER evaluation is not citable.
    const foreignOption = evaluationB.replacementOptions[0]!;
    await expectCode('invalid_replacement_option', () =>
      decideAgentLifecycle(admin, {
        evaluationId: evaluationA.id,
        change: 'terminate',
        rationale: 'Terminating A citing B\u2019s option.',
        replacementOptionId: foreignOption.id,
      }),
    );

    // The evaluation's own option is.
    const ownOption = evaluationA.replacementOptions[0]!;
    const decided = await decideAgentLifecycle(admin, {
      evaluationId: evaluationA.id,
      change: 'terminate',
      rationale: 'Capability retired.',
      replacementOptionId: ownOption.id,
    });
    expect(decided.status).toBe('awaiting_approval');
    expect(decided.replacementOptionId).toBe(ownOption.id);
    expect(decided.evaluationId).toBe(evaluationA.id);
    expect(decided.agentId).toBe(agentA.id);
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation
// ---------------------------------------------------------------------------

describe('agent-evaluation service — tenant isolation (ADR-0001)', () => {
  it('makes another tenant\u2019s records indistinguishable from missing ones', async () => {
    const admin = agentsAdmin(tenantIsolation);
    const agent = await register(admin, { ...ANALYST, slug: 'isolated-agent' });
    const submitting = member(tenantIsolation);

    const evaluation = await recordAgentEvaluation(submitting, {
      agentId: agent.id,
      replacementOptions: [{ kind: 'retain', summary: 'Baseline.' }],
    });
    const decided = await decideAgentLifecycle(admin, {
      evaluationId: evaluation.id,
      change: 'terminate',
      rationale: 'Isolation probe.',
    });
    expect(decided.status).toBe('awaiting_approval');

    // The foreign tenant cannot read, decide on or settle any of it.
    const foreign = member(tenantOther);
    await expectCode('evaluation_not_found', () =>
      getAgentEvaluation(foreign, { evaluationId: evaluation.id }),
    );
    await expectCode('decision_not_found', () =>
      getAgentLifecycleDecision(foreign, { decisionId: decided.id }),
    );
    await expectCode('evaluation_not_found', () =>
      decideAgentLifecycle(agentsAdmin(tenantOther), {
        evaluationId: evaluation.id,
        change: 'terminate',
        rationale: 'cross-tenant probe',
      }),
    );
    await expectCode('decision_not_found', () =>
      settleAgentLifecycleDecision(agentsAdmin(tenantOther), { decisionId: decided.id }),
    );

    // Measuring a foreign agent reads the same as a missing one (the
    // agents contract's uniform not-found, surfaced as this module's).
    await expectCode('agent_not_found', () =>
      recordAgentEvaluation(foreign, {
        agentId: agent.id,
        replacementOptions: [{ kind: 'retain', summary: 'x' }],
      }),
    );

    // The foreign tenant's listings stay empty.
    expect(await listAgentEvaluations(foreign, { agentId: agent.id })).toEqual([]);
    expect(await listAgentLifecycleDecisions(foreign, {})).toEqual([]);

    // And the owning tenant's state is untouched.
    const intact = await getAgentEvaluation(submitting, { evaluationId: evaluation.id });
    expect(intact.id).toBe(evaluation.id);
    expect((await getAgentLifecycleDecision(admin, { decisionId: decided.id })).status).toBe(
      'awaiting_approval',
    );
  });
});

// ---------------------------------------------------------------------------
// Storage-level evidence guarantees
// ---------------------------------------------------------------------------

describe('agent-evaluation service — append-only evidence (storage level)', () => {
  it('rejects UPDATE/DELETE on evaluations and replacement options outright', async () => {
    const admin = agentsAdmin(tenantStorage);
    const agent = await register(admin, { ...ANALYST, slug: 'storage-agent' });
    const submitting = member(tenantStorage);

    const evaluation = await recordAgentEvaluation(submitting, {
      agentId: agent.id,
      replacementOptions: [{ kind: 'retain', summary: 'Baseline.' }],
    });

    await expect(
      getDb().query(`UPDATE agent_evaluations SET cost_total_minor = 0 WHERE id = $1`, [
        evaluation.id,
      ]),
    ).rejects.toThrow(/append-only evidence/);
    await expect(
      getDb().query(`DELETE FROM agent_evaluations WHERE id = $1`, [evaluation.id]),
    ).rejects.toThrow(/append-only evidence/);
    await expect(
      getDb().query(`UPDATE agent_evaluation_replacement_options SET summary = 'forged' WHERE evaluation_id = $1`, [
        evaluation.id,
      ]),
    ).rejects.toThrow(/append-only evidence/);
    await expect(
      getDb().query(`DELETE FROM agent_evaluation_replacement_options WHERE evaluation_id = $1`, [
        evaluation.id,
      ]),
    ).rejects.toThrow(/append-only evidence/);
  });

  it('freezes decision substance and forbids DELETE, while the lifecycle may still move', async () => {
    const admin = agentsAdmin(tenantStorage);
    const agent = await register(admin, { ...ANALYST, slug: 'storage-decision-agent' });
    const submitting = member(tenantStorage);

    const evaluation = await recordAgentEvaluation(submitting, {
      agentId: agent.id,
      replacementOptions: [{ kind: 'retain', summary: 'Baseline.' }],
    });
    const decided = await decideAgentLifecycle(admin, {
      evaluationId: evaluation.id,
      change: 'terminate',
      rationale: 'Storage probe.',
    });

    // Substantive columns are frozen…
    await expect(
      getDb().query(`UPDATE agent_lifecycle_decisions SET rationale = 'forged' WHERE id = $1`, [
        decided.id,
      ]),
    ).rejects.toThrow(/frozen evidence/);
    await expect(
      getDb().query(`UPDATE agent_lifecycle_decisions SET change = 'retain' WHERE id = $1`, [
        decided.id,
      ]),
    ).rejects.toThrow(/frozen evidence/);
    await expect(
      getDb().query(`DELETE FROM agent_lifecycle_decisions WHERE id = $1`, [decided.id]),
    ).rejects.toThrow(/decision evidence/);

    // …while the lifecycle state may still move forward (the pump path).
    const moved = await getDb().query(
      `UPDATE agent_lifecycle_decisions
         SET status = 'refused', decided_by = 'policy', decided_at = now(), updated_at = now()
       WHERE id = $1 RETURNING status`,
      [decided.id],
    );
    expect(moved.rows[0]!.status).toBe('refused');
  });
});
