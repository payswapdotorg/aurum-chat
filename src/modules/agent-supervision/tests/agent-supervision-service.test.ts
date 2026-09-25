// Integration tests for the agent-supervision module against the
// embedded PostgreSQL (PGlite, `:memory:`) through the db port.
//
// Covers the W098 operational surface (the recovery/acceptance suite
// lives in agent-supervision-recovery.test.ts):
//  * registration — claim-gated, idempotent per agent, defaulting the
//    permission ceiling to the agent's CURRENT W021 grant;
//  * tenant isolation — the uniform cross-tenant not-found discipline
//    (ADR-0001) on records, reviews, sessions, events and entries;
//  * management controls — updateSupervision, budget grants (and the
//    unlimited-envelope refusal), suspend/resume transitions with
//    their transition discipline;
//  * work admission — the ceiling, waiting-state and budget refusals
//    BEFORE anything reaches the gateway; the happy path through the
//    W021 gateway with the supervision causation identity;
//  * reviews — the pump fires due reviews exactly once; outcomes
//    continue/adjust/suspend apply atomically; terminate_proposal
//    validates the cited W024 decision (existence, change, agent);
//  * the review context — the composed W021/W023/W024 evidence view;
//  * sessions — begin/heartbeat/end, dead-session refusal, expired-
//    lease recovery with durable evidence;
//  * storage-level guarantees — append-only events/reviews/entries,
//    identity-frozen records and sessions (PostgreSQL triggers).

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { systemClock } from '@/infra/clock';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import {
  AgentsError,
  registerAgent,
  runAgentExecution,
  setAgentTransport,
  updateAgent,
  type AgentRuntimeTransport,
  type AgentRuntimeTransportReceipt,
  type AgentRuntimeTransportRequest,
} from '@/modules/agents/contract';
import { recordAgentEvaluation, decideAgentLifecycle } from '@/modules/agent-evaluation/contract';
import { createTeam } from '@/modules/agent-teams/contract';
import {
  beginSupervisorSession,
  completeSupervisionReview,
  endSupervisorSession,
  getSupervision,
  getSupervisionReview,
  getSupervisionReviewContext,
  getSupervisorSession,
  grantSupervisionBudget,
  heartbeatSupervisorSession,
  listSupervisionBudgetEntries,
  listSupervisionEvents,
  listSupervisionReviews,
  listSupervisions,
  listSupervisorSessions,
  observeSupervisedAgentHealth,
  pumpSupervision,
  registerSupervisedAgent,
  resumeSupervision,
  submitSupervisedExecution,
  suspendSupervision,
  updateSupervision,
} from '../contract';
import { AgentSupervisionError } from '../errors';
import { runMigrations } from '../../../../scripts/migrate';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const tenantMain = newId();
const tenantIsolation = newId();
const tenantOther = newId();
const tenantAdmission = newId();
const tenantReviews = newId();
const tenantContext = newId();
const tenantSessions = newId();
const tenantStorage = newId();

const BASE_TIME = Date.parse('2026-09-24T12:00:00Z');
let clockMs = BASE_TIME;

function setClock(at: number): void {
  clockMs = at;
  vi.spyOn(systemClock, 'now').mockImplementation(() => new Date(clockMs));
}

function advance(seconds: number): void {
  setClock(clockMs + seconds * 1_000);
}

function member(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: [] };
}

function admin(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: ['agents:administer'] };
}

async function expectCode(
  code: AgentSupervisionError['code'],
  fn: () => Promise<unknown>,
): Promise<void> {
  try {
    await fn();
    throw new Error(`expected AgentSupervisionError('${code}') but the call succeeded`);
  } catch (error) {
    expect(error).toBeInstanceOf(AgentSupervisionError);
    expect((error as AgentSupervisionError).code).toBe(code);
  }
}

/** A minimal fake transport: delivers the canonical LangGraph dialect. */
class FakeTransport implements AgentRuntimeTransport {
  async send(request: AgentRuntimeTransportRequest): Promise<AgentRuntimeTransportReceipt> {
    return {
      status: 'delivered',
      payload: {
        run_id: `lg_${newId().slice(0, 8)}`,
        output: { result: { supervised: true, agent: request.agentId }, summary: 'done' },
        usage: { input_tokens: 1_200, output_tokens: 800, steps: 3 },
      },
      providerTaskId: `lg_${newId().slice(0, 8)}`,
      detail: null,
    };
  }
}

beforeAll(async () => {
  await runMigrations(getDb());
});

afterAll(async () => {
  setAgentTransport(null);
  await closeDb();
});

beforeEach(() => {
  setClock(BASE_TIME);
  setAgentTransport(new FakeTransport());
});

interface AgentFixture {
  agentId: string;
}

async function makeAgent(tenantId: string, slug: string): Promise<AgentFixture> {
  const result = await registerAgent(admin(tenantId), {
    slug,
    displayName: slug,
    role: 'operations',
    description: null,
    provider: 'langgraph',
    instructions: 'Do the supervised thing.',
    runtimeConfig: { assistantId: `asst_${slug}` },
    permissions: ['observe', 'analyze', 'recommend'],
  });
  return { agentId: result.agent.id };
}

// ---------------------------------------------------------------------------
// Registration, reads and tenant isolation
// ---------------------------------------------------------------------------

describe('registration and reads', () => {
  it('registers supervision with claim-gating, idempotency and grant-defaulted ceiling', async () => {
    const ctx = admin(tenantMain);
    const { agentId } = await makeAgent(tenantMain, 'reg-analyst');

    await expectCode('forbidden', () =>
      registerSupervisedAgent(member(tenantMain), { agentId }),
    );

    const first = await registerSupervisedAgent(ctx, {
      agentId,
      reviewIntervalSeconds: 3_600,
      budgetMinor: 10_000,
      ownerPrincipal: 'owner-1',
    });
    expect(first.created).toBe(true);
    expect(first.supervision.status).toBe('active');
    expect(first.supervision.healthState).toBe('unknown');
    // The ceiling defaults to the agent's CURRENT W021 grant.
    expect(first.supervision.permittedScopes).toEqual(['observe', 'analyze', 'recommend']);
    expect(first.supervision.budgetMinor).toBe(10_000);
    expect(first.supervision.budgetSpentMinor).toBe(0);
    expect(first.supervision.budgetRemainingMinor).toBe(10_000);
    expect(first.supervision.reviewIntervalSeconds).toBe(3_600);
    expect(Date.parse(first.supervision.nextReviewAt)).toBe(BASE_TIME + 3_600_000);
    expect(first.supervision.lastReviewAt).toBeNull();
    expect(first.supervision.reviewCount).toBe(0);

    // Idempotent re-registration: the first registration stands.
    const replay = await registerSupervisedAgent(ctx, {
      agentId,
      reviewIntervalSeconds: 999_999,
      budgetMinor: 1,
    });
    expect(replay.created).toBe(false);
    expect(replay.supervision.reviewIntervalSeconds).toBe(3_600);
    expect(replay.supervision.budgetMinor).toBe(10_000);

    const events = await listSupervisionEvents(ctx, { agentId, limit: 10 });
    expect(events.map((event) => event.kind)).toEqual(
      expect.arrayContaining(['registered', 'registration_replayed']),
    );
  });

  it('refuses to supervise a foreign or missing agent (the uniform not-found)', async () => {
    const ctx = admin(tenantMain);
    await expectCode('agent_not_found', () =>
      registerSupervisedAgent(ctx, { agentId: newId() }),
    );
    // An agent of ANOTHER tenant reads the same as a missing one.
    const foreign = await makeAgent(tenantOther, 'foreign-agent');
    await expectCode('agent_not_found', () =>
      registerSupervisedAgent(ctx, { agentId: foreign.agentId }),
    );
  });

  it('isolates tenants on every read surface', async () => {
    const ctxAdmin = admin(tenantIsolation);
    const { agentId } = await makeAgent(tenantIsolation, 'iso-analyst');
    await registerSupervisedAgent(ctxAdmin, { agentId });

    const strangerAdmin = admin(tenantOther);
    await expectCode('supervision_not_found', () =>
      getSupervision(strangerAdmin, { agentId }),
    );
    expect(await listSupervisions(strangerAdmin, {})).toEqual([]);
    expect(await listSupervisionEvents(strangerAdmin, { agentId, limit: 10 })).toEqual([]);
    expect(await listSupervisionReviews(strangerAdmin, { agentId, limit: 10 })).toEqual([]);
    expect(await listSupervisionBudgetEntries(strangerAdmin, { agentId, limit: 10 })).toEqual([]);
    const strangerSession = await beginSupervisorSession(strangerAdmin, {});
    await expectCode('session_not_found', () =>
      getSupervisorSession(ctxAdmin, { sessionId: strangerSession.id }),
    );
  });

  it('lists and filters supervision records', async () => {
    const ctx = admin(tenantIsolation);
    const all = await listSupervisions(ctx, {});
    expect(all.length).toBe(1);
    expect(all[0]!.agentId).toBeDefined();
    const filtered = await listSupervisions(ctx, { status: 'waiting_review' });
    expect(filtered).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Management controls
// ---------------------------------------------------------------------------

describe('management controls', () => {
  it('updates owner, cadences and ceiling, re-arming the review schedule', async () => {
    const ctx = admin(tenantMain);
    const { agentId } = await makeAgent(tenantMain, 'ctl-analyst');
    await registerSupervisedAgent(ctx, { agentId, reviewIntervalSeconds: 3_600 });

    const updated = await updateSupervision(ctx, {
      agentId,
      ownerPrincipal: 'new-owner',
      reviewIntervalSeconds: 7_200,
      permittedScopes: ['observe'],
    });
    expect(updated.ownerPrincipal).toBe('new-owner');
    expect(updated.reviewIntervalSeconds).toBe(7_200);
    expect(updated.permittedScopes).toEqual(['observe']);
    // The cadence change re-arms from now.
    expect(Date.parse(updated.nextReviewAt)).toBe(BASE_TIME + 7_200_000);

    await expectCode('forbidden', () =>
      updateSupervision(member(tenantMain), { agentId, ownerPrincipal: 'x' }),
    );
    await expectCode('invalid_input', () => updateSupervision(ctx, { agentId }));
  });

  it('grants budget append-only-evidenced and refuses grants to unlimited envelopes', async () => {
    const ctx = admin(tenantMain);
    const { agentId } = await makeAgent(tenantMain, 'budget-analyst');
    await registerSupervisedAgent(ctx, { agentId, budgetMinor: 1_000 });

    const granted = await grantSupervisionBudget(ctx, { agentId, additionalMinor: 500 });
    expect(granted.budgetMinor).toBe(1_500);
    expect(granted.budgetRemainingMinor).toBe(1_500);

    const events = await listSupervisionEvents(ctx, { agentId, kind: 'budget_granted' });
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toMatchObject({ additionalMinor: 500, fromMinor: 1000, toMinor: 1500 });

    const unlimited = await makeAgent(tenantMain, 'budget-unlimited');
    await registerSupervisedAgent(ctx, { agentId: unlimited.agentId });
    await expectCode('unlimited_budget', () =>
      grantSupervisionBudget(ctx, { agentId: unlimited.agentId, additionalMinor: 100 }),
    );
  });

  it('suspends only active actors and resumes only suspended ones', async () => {
    const ctx = admin(tenantMain);
    const { agentId } = await makeAgent(tenantMain, 'suspend-analyst');
    await registerSupervisedAgent(ctx, { agentId });

    const suspended = await suspendSupervision(ctx, { agentId, reason: 'under investigation' });
    expect(suspended.status).toBe('suspended');
    await expectCode('invalid_transition', () =>
      suspendSupervision(ctx, { agentId, reason: 'again' }),
    );

    const resumed = await resumeSupervision(ctx, { agentId, note: 'cleared' });
    expect(resumed.status).toBe('active');
    // Only a suspended actor can be resumed.
    await expectCode('invalid_transition', () => resumeSupervision(ctx, { agentId }));

    const suspendedAgain = await suspendSupervision(ctx, { agentId, reason: 'second' });
    expect(suspendedAgain.status).toBe('suspended');
    await expectCode('forbidden', () => resumeSupervision(member(tenantMain), { agentId }));
    await resumeSupervision(ctx, { agentId });
  });
});

// ---------------------------------------------------------------------------
// Work admission (budgets and permissions bite here)
// ---------------------------------------------------------------------------

describe('supervision-gated work admission', () => {
  it('admits within the ceiling and stamps the supervision causation identity', async () => {
    const ctxAdmin = admin(tenantAdmission);
    const ctxMember = member(tenantAdmission);
    const { agentId } = await makeAgent(tenantAdmission, 'admit-analyst');
    const { supervision } = await registerSupervisedAgent(ctxAdmin, {
      agentId,
      permittedScopes: ['observe', 'analyze'],
    });

    // Any tenant member may submit supervised work (the W009 gate
    // applies inside the gateway, as for every execution).
    const execution = await submitSupervisedExecution(ctxMember, {
      agentId,
      task: { duty: 'summarize the queue' },
      requestedPermissions: ['observe', 'analyze'],
      idempotencyKey: 'admission-1',
    });
    // ANALYZE-level submissions are policy-allowed by the built-in
    // matrix → queued immediately.
    expect(execution.status).toBe('queued');
    expect(execution.causationId).toBe(`agent-supervision:${supervision.id}`);
    expect(execution.idempotencyKey).toBe('admission-1');

    // Idempotent replay while the supervision contract is unchanged.
    const replay = await submitSupervisedExecution(ctxMember, {
      agentId,
      task: { duty: 'summarize the queue' },
      requestedPermissions: ['observe'],
      idempotencyKey: 'admission-1',
    });
    expect(replay.id).toBe(execution.id);
  });

  it('refuses scopes beyond the ceiling before anything reaches the gateway', async () => {
    const ctxAdmin = admin(tenantAdmission);
    const ctxMember = member(tenantAdmission);
    const { agentId } = await makeAgent(tenantAdmission, 'ceiling-analyst');
    await registerSupervisedAgent(ctxAdmin, { agentId, permittedScopes: ['observe'] });

    await expectCode('scope_not_permitted', () =>
      submitSupervisedExecution(ctxMember, {
        agentId,
        task: { duty: 'x' },
        requestedPermissions: ['observe', 'analyze'],
      }),
    );
    // Nothing was recorded by the refused admission.
    expect(
      (await listSupervisionEvents(ctxAdmin, { agentId, limit: 10 })).filter(
        (event) => event.kind === 'budget_consumed',
      ),
    ).toEqual([]);
  });

  it('refuses work while the actor waits in any waiting state', async () => {
    const ctxAdmin = admin(tenantAdmission);
    const ctxMember = member(tenantAdmission);
    const { agentId } = await makeAgent(tenantAdmission, 'waiting-analyst');
    await registerSupervisedAgent(ctxAdmin, { agentId });

    const suspended = await suspendSupervision(ctxAdmin, { agentId, reason: 'pause' });
    expect(suspended.status).toBe('suspended');
    await expectCode('not_active', () =>
      submitSupervisedExecution(ctxMember, {
        agentId,
        task: { duty: 'x' },
        requestedPermissions: ['observe'],
      }),
    );
    await resumeSupervision(ctxAdmin, { agentId });

    // waiting_review: fire a due review by advancing past the cursor.
    const short = await makeAgent(tenantAdmission, 'waiting-review-analyst');
    await registerSupervisedAgent(ctxAdmin, {
      agentId: short.agentId,
      reviewIntervalSeconds: 60,
    });
    advance(61);
    const outcome = await pumpSupervision(ctxAdmin, { agentId: short.agentId });
    expect(outcome.status).toBe('review_due');
    expect(outcome.supervisionStatus).toBe('waiting_review');
    await expectCode('not_active', () =>
      submitSupervisedExecution(ctxMember, {
        agentId: short.agentId,
        task: { duty: 'x' },
        requestedPermissions: ['observe'],
      }),
    );
  });

  it('refuses work once ledgered spend reaches the envelope (before the pump even fires)', async () => {
    const ctxAdmin = admin(tenantAdmission);
    const ctxMember = member(tenantAdmission);
    const { agentId } = await makeAgent(tenantAdmission, 'budget-wait-analyst');
    await registerSupervisedAgent(ctxAdmin, { agentId, budgetMinor: 5_000 });

    // Ledger spend directly to the envelope — the exact durable state
    // a dead supervisor leaves behind mid-accounting (the pump never
    // fired the paused_budget transition). Admission must still refuse.
    const record = await getSupervision(ctxAdmin, { agentId });
    await getDb().query(
      `UPDATE agent_supervision_records SET budget_spent_minor = 5000 WHERE tenant_id = $1 AND id = $2`,
      [ctxAdmin.tenantId, record.id],
    );

    await expectCode('budget_exhausted', () =>
      submitSupervisedExecution(ctxMember, {
        agentId,
        task: { duty: 'x' },
        requestedPermissions: ['observe'],
      }),
    );

    // A grant recovers the paused_budget waiting state (here the actor
    // was never paused — the grant simply lifts the envelope).
    const granted = await grantSupervisionBudget(ctxAdmin, { agentId, additionalMinor: 5_000 });
    expect(granted.budgetRemainingMinor).toBe(5_000);
    const execution = await submitSupervisedExecution(ctxMember, {
      agentId,
      task: { duty: 'x' },
      requestedPermissions: ['observe'],
    });
    expect(execution.status).toBe('queued');
  });

  it('propagates the gateway\'s own refusals unchanged (disabled agent)', async () => {
    const ctxAdmin = admin(tenantAdmission);
    const { agentId } = await makeAgent(tenantAdmission, 'disabled-analyst');
    await registerSupervisedAgent(ctxAdmin, { agentId });
    await updateAgent(ctxAdmin, { agentId, status: 'disabled' });
    try {
      await submitSupervisedExecution(member(tenantAdmission), {
        agentId,
        task: { duty: 'x' },
        requestedPermissions: ['observe'],
      });
      throw new Error('expected the gateway to refuse a disabled agent');
    } catch (error) {
      expect(error).toBeInstanceOf(AgentsError);
      expect((error as AgentsError).code).toBe('agent_disabled');
    }
  });
});

// ---------------------------------------------------------------------------
// Reviews
// ---------------------------------------------------------------------------

describe('reviews', () => {
  it('fires due reviews exactly once and completes them (continue/adjust/suspend)', async () => {
    const ctx = admin(tenantReviews);
    const { agentId } = await makeAgent(tenantReviews, 'review-analyst');
    await registerSupervisedAgent(ctx, { agentId, reviewIntervalSeconds: 120, budgetMinor: 1_000 });

    advance(121);
    const first = await pumpSupervision(ctx, { agentId });
    expect(first.status).toBe('review_due');
    // A duplicate sweep of the same due review changes nothing.
    const second = await pumpSupervision(ctx, { agentId });
    expect(second.status).not.toBe('review_due');

    // A plain member may not complete reviews (management action).
    await expectCode('forbidden', () =>
      completeSupervisionReview(member(tenantReviews), {
        agentId,
        outcome: 'continue',
        rationale: 'no',
      }),
    );
    // Reviews complete only from the waiting_review state.
    const activeAgent = await makeAgent(tenantReviews, 'review-active-analyst');
    await registerSupervisedAgent(ctx, { agentId: activeAgent.agentId });
    await expectCode('review_not_due', () =>
      completeSupervisionReview(ctx, {
        agentId: activeAgent.agentId,
        outcome: 'continue',
        rationale: 'not waiting',
      }),
    );

    const review = await completeSupervisionReview(ctx, {
      agentId,
      outcome: 'adjust',
      rationale: 'tighten the ceiling and extend the budget',
      adjustments: {
        permittedScopes: ['observe', 'analyze'],
        budgetAdditionalMinor: 2_000,
        reviewIntervalSeconds: 240,
      },
    });
    expect(review.outcome).toBe('adjust');
    expect(review.adjustments).toMatchObject({ budgetAdditionalMinor: 2_000 });

    const after = await getSupervision(ctx, { agentId });
    expect(after.status).toBe('active');
    expect(after.reviewCount).toBe(1);
    expect(after.permittedScopes).toEqual(['observe', 'analyze']);
    expect(after.budgetMinor).toBe(3_000); // 1_000 envelope + 2_000 granted by the review
    expect(typeof after.lastReviewAt).toBe('string');
    // The adjusted cadence armed the next review.
    expect(Date.parse(after.nextReviewAt) - clockMs).toBe(240_000);

    const fetched = await getSupervisionReview(ctx, { reviewId: review.id });
    expect(fetched.id).toBe(review.id);
    const listed = await listSupervisionReviews(ctx, { agentId });
    expect(listed).toHaveLength(1);

    // Suspend through a review outcome.
    advance(241);
    await pumpSupervision(ctx, { agentId });
    const suspended = await completeSupervisionReview(ctx, {
      agentId,
      outcome: 'suspend',
      rationale: 'conduct concerns',
    });
    expect(suspended.outcome).toBe('suspend');
    expect((await getSupervision(ctx, { agentId })).status).toBe('suspended');
  });

  it('validates the cited W024 decision on a termination proposal', async () => {
    const ctx = admin(tenantReviews);
    const { agentId } = await makeAgent(tenantReviews, 'terminal-analyst');
    await registerSupervisedAgent(ctx, { agentId, reviewIntervalSeconds: 60 });
    advance(61);
    await pumpSupervision(ctx, { agentId });

    // A missing decision id.
    await expectCode('invalid_input', () =>
      completeSupervisionReview(ctx, {
        agentId,
        outcome: 'terminate_proposal',
        rationale: 'stop',
      }),
    );
    // A foreign/unreadable decision.
    await expectCode('invalid_decision_link', () =>
      completeSupervisionReview(ctx, {
        agentId,
        outcome: 'terminate_proposal',
        rationale: 'stop',
        decisionId: newId(),
      }),
    );

    // A REAL terminate decision for THIS agent, through W024.
    const evaluation = await recordAgentEvaluation(ctx, {
      agentId,
      replacementOptions: [
        {
          kind: 'eliminate',
          summary: 'the supervised duty is no longer needed',
          estimatedCostMinor: 0,
          estimatedCostCurrency: 'USD',
        },
      ],
    });
    const decision = await decideAgentLifecycle(ctx, {
      evaluationId: evaluation.id,
      change: 'terminate',
      rationale: 'measured outcomes justify termination',
    });
    // A RETAIN decision must NOT be citable by a termination proposal.
    const retainDecision = await decideAgentLifecycle(ctx, {
      evaluationId: evaluation.id,
      change: 'retain',
      rationale: 'keep for now',
    });
    await expectCode('invalid_decision_link', () =>
      completeSupervisionReview(ctx, {
        agentId,
        outcome: 'terminate_proposal',
        rationale: 'stop',
        decisionId: retainDecision.id,
      }),
    );

    const proposal = await completeSupervisionReview(ctx, {
      agentId,
      outcome: 'terminate_proposal',
      rationale: 'measured evidence says stop',
      decisionId: decision.id,
    });
    expect(proposal.outcome).toBe('terminate_proposal');
    const waiting = await getSupervision(ctx, { agentId });
    expect(waiting.status).toBe('waiting_termination');
    expect(waiting.terminationDecisionId).toBe(decision.id);

    // The evaluation linkage is validated too.
    advance(120);
    await pumpSupervision(ctx, { agentId }); // still waiting_termination: no review fires
    expect((await getSupervision(ctx, { agentId })).status).toBe('waiting_termination');
  });
});

// ---------------------------------------------------------------------------
// The composed review context (W021 + W023 + W024)
// ---------------------------------------------------------------------------

describe('the composed review context', () => {
  it('composes the agent summary, team memberships and latest evaluation', async () => {
    const ctx = admin(tenantContext);
    const { agentId } = await makeAgent(tenantContext, 'context-analyst');
    await registerSupervisedAgent(ctx, { agentId });

    // No team, no evaluation yet.
    const bare = await getSupervisionReviewContext(ctx, { agentId });
    expect(bare.teams).toEqual([]);
    expect(bare.latestEvaluation).toBeNull();
    expect(bare.agent.slug).toBe('context-analyst');
    expect(bare.supervision.status).toBe('active');

    // Put the agent on a team (W023) and measure it (W024).
    await createTeam(ctx, {
      slug: 'context-team',
      displayName: 'Context Team',
      description: null,
      topology: 'flat',
      members: [{ agentId, role: 'analyst' }],
      objectives: [{ key: 'coverage', objective: 'Cover the queue', successCriteria: null }],
      budget: { amountMinor: 100_000, currency: 'USD' },
    });
    await recordAgentEvaluation(ctx, {
      agentId,
      replacementOptions: [
        {
          kind: 'retain',
          summary: 'keep the current analyst',
          estimatedCostMinor: 100,
          estimatedCostCurrency: 'USD',
        },
      ],
    });

    const composed = await getSupervisionReviewContext(ctx, { agentId });
    expect(composed.teams).toHaveLength(1);
    expect(composed.teams[0]).toMatchObject({ slug: 'context-team', role: 'analyst', status: 'draft' });
    expect(composed.latestEvaluation).not.toBeNull();
    expect(composed.latestEvaluation!.evaluationId).toBeDefined();

    await expectCode('supervision_not_found', () =>
      getSupervisionReviewContext(ctx, { agentId: newId() }),
    );
  });
});

// ---------------------------------------------------------------------------
// Health observation
// ---------------------------------------------------------------------------

describe('health observation', () => {
  it('derives health from execution evidence and records it durably', async () => {
    const ctxAdmin = admin(tenantMain);
    const ctxMember = member(tenantMain);
    const { agentId } = await makeAgent(tenantMain, 'health-analyst');
    await registerSupervisedAgent(ctxAdmin, { agentId });

    // No executions → unknown (first-class).
    const unknown = await observeSupervisedAgentHealth(ctxAdmin, { agentId });
    expect(unknown.healthState).toBe('unknown');
    expect(unknown.healthObservedAt).not.toBeNull();

    // One succeeded execution → healthy.
    const execution = await submitSupervisedExecution(ctxMember, {
      agentId,
      task: { duty: 'x' },
      requestedPermissions: ['observe'],
    });
    await runAgentExecution(ctxMember, { executionId: execution.id });

    const healthy = await observeSupervisedAgentHealth(ctxAdmin, { agentId });
    expect(healthy.healthState).toBe('healthy');
    expect(healthy.healthDetail).toContain('1 execution(s) in window');

    const events = await listSupervisionEvents(ctxAdmin, { agentId, kind: 'health_observed' });
    expect(events.length).toBe(2); // unknown then healthy — append-only
  });
});

// ---------------------------------------------------------------------------
// Supervisor sessions
// ---------------------------------------------------------------------------

describe('supervisor sessions', () => {
  it('begins, heartbeats and ends sessions with lease discipline', async () => {
    const ctx = admin(tenantSessions);
    const session = await beginSupervisorSession(ctx, { leaseSeconds: 60 });
    expect(session.endReason).toBeNull();
    expect(session.leaseExpiresAt).toBe(new Date(BASE_TIME + 60_000).toISOString());

    advance(30);
    const beat = await heartbeatSupervisorSession(ctx, { sessionId: session.id });
    // The extension anchors to the CURRENT time, not the old expiry.
    expect(beat.leaseExpiresAt).toBe(new Date(BASE_TIME + 30_000 + 60_000).toISOString());
    expect(beat.lastHeartbeatAt).toBe(new Date(BASE_TIME + 30_000).toISOString());

    const ended = await endSupervisorSession(ctx, { sessionId: session.id, reason: 'deploy' });
    expect(ended.endReason).toBe('ended');
    await expectCode('session_not_live', () =>
      heartbeatSupervisorSession(ctx, { sessionId: session.id }),
    );
    await expectCode('session_not_live', () =>
      endSupervisorSession(ctx, { sessionId: session.id }),
    );

    const listed = await listSupervisorSessions(ctx, { live: false });
    expect(listed).toHaveLength(1);
    expect(await listSupervisorSessions(ctx, { live: true })).toEqual([]);
  });

  it('recovers expired sessions durably and refuses to pump under a dead session', async () => {
    const ctx = admin(tenantSessions);
    const dead = await beginSupervisorSession(ctx, { leaseSeconds: 60 });
    advance(120); // the worker died; the lease lapses

    const fresh = await beginSupervisorSession(ctx, { leaseSeconds: 60 });
    const recoveredRow = await getSupervisorSession(ctx, { sessionId: dead.id });
    expect(recoveredRow.endReason).toBe('lease_expired_recovered');
    expect(recoveredRow.recoveredBySessionId).toBe(fresh.id);

    const events = await listSupervisionEvents(ctx, { sessionId: dead.id });
    expect(events.map((event) => event.kind)).toContain('session_recovered');

    // The pump refuses the dead session's identity.
    const { agentId } = await makeAgent(tenantSessions, 'session-analyst');
    await registerSupervisedAgent(ctx, { agentId });
    await expectCode('session_not_live', () =>
      pumpSupervision(ctx, { agentId, sessionId: dead.id }),
    );
    // The fresh session supervises fine.
    const outcome = await pumpSupervision(ctx, { agentId, sessionId: fresh.id });
    expect(['idle', 'health_observed']).toContain(outcome.status);

    // A late heartbeat cannot resurrect the dead session.
    await expectCode('session_not_live', () =>
      heartbeatSupervisorSession(ctx, { sessionId: dead.id }),
    );
  });

  it('stamps pump-attributed events with the driving session', async () => {
    const ctx = admin(tenantSessions);
    const { agentId } = await makeAgent(tenantSessions, 'stamp-analyst');
    await registerSupervisedAgent(ctx, { agentId, reviewIntervalSeconds: 60 });
    const session = await beginSupervisorSession(ctx, {});
    advance(61);
    const outcome = await pumpSupervision(ctx, { agentId, sessionId: session.id });
    expect(outcome.status).toBe('review_due');
    const events = await listSupervisionEvents(ctx, { agentId, kind: 'review_due' });
    expect(events[0]!.sessionId).toBe(session.id);
  });
});

// ---------------------------------------------------------------------------
// Storage-level guarantees (triggers)
// ---------------------------------------------------------------------------

describe('storage-level guarantees', () => {
  it('freezes supervision-record identity and forbids erasure', async () => {
    const ctx = admin(tenantStorage);
    const { agentId } = await makeAgent(tenantStorage, 'storage-analyst');
    const { supervision } = await registerSupervisedAgent(ctx, { agentId });

    await expect(
      getDb().query(`UPDATE agent_supervision_records SET agent_id = $1 WHERE id = $2`, [
        newId(),
        supervision.id,
      ]),
    ).rejects.toThrow(/identity is immutable/);
    await expect(
      getDb().query(`DELETE FROM agent_supervision_records WHERE id = $1`, [supervision.id]),
    ).rejects.toThrow(/never erased/);
    // Control columns move freely through the service — the trigger
    // permits them (status moves via the pump elsewhere in this suite).
  });

  it('makes events, reviews and budget entries append-only at the storage level', async () => {
    const ctx = admin(tenantStorage);
    const { agentId } = await makeAgent(tenantStorage, 'append-analyst');
    const { supervision } = await registerSupervisedAgent(ctx, { agentId });
    const event = (await listSupervisionEvents(ctx, { agentId, limit: 1 }))[0]!;

    await expect(
      getDb().query(`UPDATE agent_supervision_events SET detail = 'rewritten' WHERE id = $1`, [
        event.id,
      ]),
    ).rejects.toThrow(/immutable history/);
    await expect(
      getDb().query(`DELETE FROM agent_supervision_events WHERE id = $1`, [event.id]),
    ).rejects.toThrow(/immutable history/);

    await expect(
      getDb().query(
        `INSERT INTO agent_supervision_reviews (
           tenant_id, supervision_id, agent_id, outcome, rationale, reviewed_by, reviewed_at
         ) VALUES ($1, $2, $3, 'continue', 'r', $4, now())`,
        [ctx.tenantId, supervision.id, agentId, ctx.principalId],
      ),
    ).resolves.toBeDefined();
    const review = (await listSupervisionReviews(ctx, { agentId }))[0]!;
    await expect(
      getDb().query(`UPDATE agent_supervision_reviews SET rationale = 'x' WHERE id = $1`, [
        review.id,
      ]),
    ).rejects.toThrow(/immutable history/);

    await expect(
      getDb().query(
        `INSERT INTO agent_supervision_budget_entries (
           tenant_id, supervision_id, agent_id, execution_id, attempt_id,
           cost_minor, cost_currency, recorded_by, recorded_at
         ) VALUES ($1, $2, $3, $4, $5, 100, 'USD', $6, now())`,
        [ctx.tenantId, supervision.id, agentId, newId(), newId(), ctx.principalId],
      ),
    ).resolves.toBeDefined();
    const entry = (await listSupervisionBudgetEntries(ctx, { agentId }))[0]!;
    await expect(
      getDb().query(`DELETE FROM agent_supervision_budget_entries WHERE id = $1`, [entry.id]),
    ).rejects.toThrow(/immutable history/);
  });

  it('freezes supervisor-session identity and end state', async () => {
    const ctx = admin(tenantStorage);
    const session = await beginSupervisorSession(ctx, { leaseSeconds: 60 });
    await expect(
      getDb().query(`UPDATE agent_supervisor_sessions SET lease_seconds = 999 WHERE id = $1`, [
        session.id,
      ]),
    ).rejects.toThrow(/identity and lease cadence are immutable/);
    await endSupervisorSession(ctx, { sessionId: session.id });
    // Moving the frozen end instant trips the guard (the CHECK alone
    // would permit this shape: ended_at stays NOT NULL).
    await expect(
      getDb().query(`UPDATE agent_supervisor_sessions SET ended_at = now() WHERE id = $1`, [
        session.id,
      ]),
    ).rejects.toThrow(/end state may not change/);
    await expect(
      getDb().query(`DELETE FROM agent_supervisor_sessions WHERE id = $1`, [session.id]),
    ).rejects.toThrow(/DELETE is forbidden/);
  });
});
