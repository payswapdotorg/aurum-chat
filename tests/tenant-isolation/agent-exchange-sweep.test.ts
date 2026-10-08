// W136 integration (2026-10-08) — Tenant Isolation Verification · sweep for
// the agent-exchange module (W136: Agent Exchange + Execution Plan +
// Cross-Agent Relay — the durable orchestration projection: execution
// plans, task decompositions, organization members, relay handoffs,
// governed approvals and execution runs).
//
// REAL two-tenant service proof in the W044 house style (the manifest v10
// registration): tenant A builds exchange state through the public
// contract — an execution plan over a real W008 goal (task decomposition +
// organization members), a relay handoff, a governed approval over a REAL
// decided W009 action request, and an execution run over a REAL W021
// agent execution with an OPEN W040 outcome link — and tenant B must see
// none of it:
//
//   * empty-list invisibility — B's listExecutionPlans is empty before it
//     creates its own state, and its plan-scoped list views (runs,
//     handoffs, approvals) are empty over A's plan ids;
//   * uniform not-found — a FOREIGN plan id and a MISSING one reject
//     identically on every surface (`plan_not_found` on the read, the
//     lifecycle transitions, the handoff/approval/run appends), and the
//     mapped `goal_not_found` / `agent_ref_not_found` from the consumed
//     contracts cover the composition paths — no existence leak
//     (ADR-0001);
//   * same natural keys coexist per tenant — the tenant-unique agent slug
//     lives independently in both tenants, and each tenant's same-shaped
//     plans (identical task keys, member keys and objective text) stay
//     fully isolated with their evidence tails;
//   * writes never mutate another tenant's rows — B cannot complete or
//     abandon A's plan, cannot append handoffs/approvals/runs to it,
//     cannot plan A's goal, and cannot even staff its own organization
//     with A's tenant agent (the W021 seam's uniform not-found).
//
// Scope rules honored here: agent-exchange code is imported ONLY through
// '@/modules/agent-exchange/contract'; the goals/agents/actions/learning
// fixtures come through their public contracts (the consumed seams,
// exercised as real records — never direct SQL writes).

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { runMigrations } from '../../scripts/migrate';

import {
  abandonExecutionPlan,
  completeExecutionPlan,
  createExecutionPlan,
  getExecutionPlan,
  listApprovals,
  listExecutionPlans,
  listExecutionRuns,
  listHandoffs,
  recordApproval,
  recordExecutionRun,
  recordHandoff,
} from '@/modules/agent-exchange/contract';
import { AgentExchangeError } from '@/modules/agent-exchange/contract';
import type { AgentExchangeErrorCode, ExecutionPlan } from '@/modules/agent-exchange/contract';
import { createGoal } from '@/modules/goals/contract';
import { registerAgent, submitAgentExecution } from '@/modules/agents/contract';
import { authorizeAction, decideApproval } from '@/modules/actions/contract';
import { defineOutcome } from '@/modules/learning/contract';

const tenantSweepA = newId();
const tenantSweepB = newId();

function member(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: [] };
}

function administer(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: ['agents:administer'] };
}

function approver(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: ['actions:approve'] };
}

async function expectCode(code: AgentExchangeErrorCode, fn: () => unknown): Promise<void> {
  try {
    await fn();
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(AgentExchangeError);
    expect((error as AgentExchangeError).code).toBe(code);
  }
}

function sweepGoalInput(title: string) {
  return {
    title,
    objective: `Objective of ${title}`,
    desiredState: `Desired state of ${title}`,
    horizonEnd: '2027-12-31T00:00:00.000Z',
    owner: { kind: 'team' as const, label: 'operations' },
    priority: 'high' as const,
    successCriteria: 'Measurable success',
    actor: { kind: 'system' as const, label: 'w136-sweep' },
  };
}

/** The W136 plan decomposition + organization fixture (same shape in both tenants). */
function sweepPlanInput(goalId: string) {
  return {
    goalId,
    objective: 'Execute the sweep program through the exchange',
    tasks: [
      { taskKey: 'survey', title: 'Survey the site' },
      { taskKey: 'dispatch', title: 'Dispatch crews', dependsOn: ['survey'], assigneeMemberKey: 'lead' },
      { taskKey: 'report', title: 'Report outcomes', dependsOn: ['dispatch'] },
    ],
    // The default organization keeps 'lead' ref-free (human-capability) so
    // probes that stop at an earlier gate (the goal gate) never depend on
    // the consumed registry seams; the tenant-agent staffing is supplied
    // by the callers that prove it.
    members: [
      { memberKey: 'lead', kind: 'human-capability' as const, role: 'Lead specialist' },
      { memberKey: 'auditor', kind: 'human-capability' as const, role: 'Program auditor' },
    ],
  };
}

beforeAll(async () => {
  await runMigrations(getDb());
});

afterAll(async () => {
  await closeDb();
});

describe('W044 agent-exchange — the orchestration projection (W136) is tenant-scoped', () => {
  it("tenant A's plans, tasks, members, handoffs, approvals and runs are invisible to tenant B; the same plan shape and agent slug coexist per tenant", async () => {
    const ctxA = member(tenantSweepA);
    const ctxAAdmin = administer(tenantSweepA);
    const ctxAApprover = approver(tenantSweepA);
    const ctxB = member(tenantSweepB);
    const ctxBAdmin = administer(tenantSweepB);

    // ---- Tenant A: the exchange state, through the real consumed seams --
    const goalA = await createGoal(ctxA, sweepGoalInput('W136 sweep exchange program'));
    // The tenant-unique agent slug BOTH tenants will use (the coexistence
    // proof below).
    const agentA = (await registerAgent(ctxAAdmin, {
      slug: 'sweep-specialist',
      displayName: 'Sweep specialist',
      role: 'specialist execution',
      description: 'Executes plan tasks.',
      provider: 'openai-assistants',
      instructions: 'Execute the assigned task and report.',
      permissions: ['observe', 'analyze'],
      runtimeConfig: { assistantId: 'asst_w136_sweep_a' },
    })).agent;
    const planA = await createExecutionPlan(ctxA, {
      ...sweepPlanInput(goalA.id),
      members: [
        { memberKey: 'lead', kind: 'tenant-agent' as const, role: 'Lead specialist', ref: agentA.id },
        { memberKey: 'auditor', kind: 'human-capability' as const, role: 'Program auditor' },
      ],
      note: 'the sweep plan',
    });
    expect(planA.tenantId).toBe(tenantSweepA);
    expect(planA.status).toBe('active');
    expect(planA.tasks.map((task) => task.taskKey)).toEqual(['survey', 'dispatch', 'report']);
    expect(planA.members.map((m) => m.memberKey)).toEqual(['auditor', 'lead']);

    // A relay handoff over A's own plan (the minimal evidence-linked
    // context package).
    const handoffA = await recordHandoff(ctxA, {
      planId: planA.id,
      taskKey: 'dispatch',
      fromMemberKey: 'lead',
      toMemberKey: 'auditor',
      context: { evidenceRefs: ['w136-sweep-survey-digest'] },
      note: 'hand the survey evidence to the auditor',
    });
    expect(handoffA.taskKey).toBe('dispatch');

    // A governed approval over a REAL decided W009 action request.
    const requestA = await authorizeAction(ctxA, {
      actionKind: 'agent-execution',
      authorityLevel: 'EXECUTE',
      payload: { taskKey: 'dispatch', what: 'the sweep program execution' },
      justification: 'the sweep program is ready',
    });
    await decideApproval(ctxAApprover, {
      requestId: requestA.id,
      decision: 'approve',
    });
    const approvalA = await recordApproval(ctxA, {
      planId: planA.id,
      taskKey: 'dispatch',
      actionRequestId: requestA.id,
    });
    expect(approvalA.decision.status).toBe('approved');

    // An execution run over a REAL W021 execution (live: PROGRESS) with an
    // OPEN W040 outcome link — the commitment before realization.
    const executionA = await submitAgentExecution(ctxA, {
      agentId: agentA.id,
      task: { instruction: 'Survey the site', context: 'sweep window' },
      requestedPermissions: ['observe'],
    });
    const outcomeA = await defineOutcome(ctxA, {
      subject: { kind: 'recommendation', id: newId(), label: 'w136 sweep outcome' },
      metricName: 'sites surveyed per week',
      metricUnit: 'sites',
      direction: 'at_least',
      baseline: 0,
      expected: 3,
      horizon: null,
      affectedGoals: [],
      originExecutionId: null,
      actor: { kind: 'person', label: 'ops lead' },
      rationale: 'the w136 sweep commitment',
    });
    const runA = await recordExecutionRun(ctxA, {
      planId: planA.id,
      taskKey: 'dispatch',
      agentExecutionId: executionA.id,
      context: { evidenceRefs: ['w136-sweep-dispatch-brief'] },
      outcomeId: outcomeA.id,
    });
    expect(runA.agentId).toBe(agentA.id);
    expect(runA.outcomeId).toBe(outcomeA.id);

    // ---- Tenant B sees none of it ---------------------------------------
    expect(await listExecutionPlans(ctxB, {})).toHaveLength(0);

    // Uniform not-founds: a FOREIGN plan id and a MISSING one are
    // indistinguishable on every read and transition surface.
    await expectCode('plan_not_found', () =>
      getExecutionPlan(ctxB, { planId: planA.id }),
    );
    await expectCode('plan_not_found', () =>
      getExecutionPlan(ctxB, { planId: newId() }),
    );
    await expectCode('plan_not_found', () =>
      completeExecutionPlan(ctxB, { planId: planA.id, note: 'cross-tenant probe' }),
    );
    await expectCode('plan_not_found', () =>
      completeExecutionPlan(ctxB, { planId: newId(), note: 'cross-tenant probe' }),
    );
    await expectCode('plan_not_found', () =>
      abandonExecutionPlan(ctxB, { planId: planA.id, reason: 'cross-tenant probe' }),
    );

    // The plan-scoped evidence lists follow the filtered-list house style
    // (org-lab listRecommendations): a foreign plan is an EMPTY list,
    // never an existence leak.
    expect(await listExecutionRuns(ctxB, { planId: planA.id })).toEqual([]);
    expect(await listHandoffs(ctxB, { planId: planA.id })).toEqual([]);
    expect(await listApprovals(ctxB, { planId: planA.id })).toEqual([]);
    // The plan LIST view filtered over A's goal is equally blind.
    expect(await listExecutionPlans(ctxB, { goalId: goalA.id })).toEqual([]);

    // Cross-tenant WRITES are refused the same way: B cannot append relay
    // handoffs, governed approvals or execution runs to A's plan (the plan
    // gate fires before any consumed seam is touched — a foreign plan and
    // a missing one reject identically).
    await expectCode('plan_not_found', () =>
      recordHandoff(ctxB, {
        planId: planA.id,
        taskKey: 'dispatch',
        fromMemberKey: 'lead',
        toMemberKey: 'auditor',
      }),
    );
    await expectCode('plan_not_found', () =>
      recordHandoff(ctxB, {
        planId: newId(),
        taskKey: 'dispatch',
        fromMemberKey: 'lead',
        toMemberKey: 'auditor',
      }),
    );
    await expectCode('plan_not_found', () =>
      recordApproval(ctxB, { planId: planA.id, actionRequestId: requestA.id }),
    );
    await expectCode('plan_not_found', () =>
      recordExecutionRun(ctxB, {
        planId: planA.id,
        taskKey: 'dispatch',
        agentExecutionId: executionA.id,
      }),
    );
    await expectCode('plan_not_found', () =>
      recordExecutionRun(ctxB, {
        planId: newId(),
        taskKey: 'dispatch',
        agentExecutionId: newId(),
      }),
    );

    // B cannot COMPOSE over A's records either: not over A's goal (the
    // W008 seam's uniform not-found), and not staffing its own
    // organization with A's tenant agent (the W021 seam's uniform
    // not-found — the org-lab sweep's stolen-body precedent).
    await expectCode('goal_not_found', () =>
      createExecutionPlan(ctxB, {
        ...sweepPlanInput(goalA.id),
        objective: 'cross-tenant probe over A\'s goal',
      }),
    );
    await expectCode('goal_not_found', () =>
      createExecutionPlan(ctxB, {
        ...sweepPlanInput(newId()),
        objective: 'cross-tenant probe over a missing goal',
      }),
    );
    const goalB = await createGoal(ctxB, sweepGoalInput('W136 sweep exchange program'));
    await expectCode('agent_ref_not_found', () =>
      createExecutionPlan(ctxB, {
        ...sweepPlanInput(goalB.id),
        members: [
          { memberKey: 'lead', kind: 'tenant-agent' as const, role: 'Lead', ref: agentA.id },
        ],
      }),
    );

    // ---- The same natural keys coexist per tenant ------------------------
    // The tenant-unique agent slug 'sweep-specialist' lives independently
    // in B, and B's same-shaped plan (identical task keys, member keys
    // and objective text) is fully its own.
    const agentB = (await registerAgent(ctxBAdmin, {
      slug: 'sweep-specialist',
      displayName: 'Sweep specialist (tenant B)',
      role: 'specialist execution',
      description: 'Executes plan tasks.',
      provider: 'openai-assistants',
      instructions: 'Execute the assigned task and report.',
      permissions: ['observe', 'analyze'],
      runtimeConfig: { assistantId: 'asst_w136_sweep_b' },
    })).agent;
    expect(agentB.id).not.toBe(agentA.id);
    const planB: ExecutionPlan = await createExecutionPlan(ctxB, {
      ...sweepPlanInput(goalB.id),
      members: [
        { memberKey: 'lead', kind: 'tenant-agent' as const, role: 'Lead specialist', ref: agentB.id },
        { memberKey: 'auditor', kind: 'human-capability' as const, role: 'Program auditor' },
      ],
      note: 'the sweep plan',
    });
    expect(planB.id).not.toBe(planA.id);
    expect(planB.tenantId).toBe(tenantSweepB);
    expect(planB.tasks.map((task) => task.taskKey)).toEqual(planA.tasks.map((task) => task.taskKey));
    expect(planB.members.map((m) => m.memberKey)).toEqual(planA.members.map((m) => m.memberKey));
    expect(planB.objective).toBe(planA.objective);
    // Each tenant's plan LIST holds exactly its own plan.
    expect((await listExecutionPlans(ctxA, {})).map((plan) => plan.id)).toEqual([planA.id]);
    expect((await listExecutionPlans(ctxB, {})).map((plan) => plan.id)).toEqual([planB.id]);

    // ---- The evidence tails stay tenant-scoped ---------------------------
    // A's plan carries exactly the handoff, approval and run it recorded;
    // B's same-shaped plan carries none (its relay is honestly cold).
    expect((await listHandoffs(ctxA, { planId: planA.id })).map((handoff) => handoff.id)).toEqual([
      handoffA.id,
    ]);
    expect((await listApprovals(ctxA, { planId: planA.id })).map((approval) => approval.id)).toEqual([
      approvalA.id,
    ]);
    expect((await listExecutionRuns(ctxA, { planId: planA.id })).map((run) => run.id)).toEqual([
      runA.id,
    ]);
    expect(await listHandoffs(ctxB, { planId: planB.id })).toHaveLength(0);
    expect(await listApprovals(ctxB, { planId: planB.id })).toHaveLength(0);
    expect(await listExecutionRuns(ctxB, { planId: planB.id })).toHaveLength(0);

    // B records its own evidence over ITS plan (the surface serves B
    // normally — isolation is not breakage), and A's tail is unchanged.
    const handoffB = await recordHandoff(ctxB, {
      planId: planB.id,
      taskKey: 'survey',
      fromMemberKey: 'lead',
      toMemberKey: 'auditor',
      context: { evidenceRefs: ['w136-sweep-b-evidence'] },
    });
    expect(handoffB.tenantId).toBe(tenantSweepB);
    expect(await listHandoffs(ctxA, { planId: planA.id })).toHaveLength(1);
    expect(await listHandoffs(ctxB, { planId: planB.id })).toHaveLength(1);
  });
});
