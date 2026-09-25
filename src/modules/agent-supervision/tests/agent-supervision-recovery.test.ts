// THE W098 ACCEPTANCE SUITE — persistent agent supervision and
// recovery, proven against the embedded PostgreSQL (PGlite,
// `:memory:`) through the db port.
//
// Work item: "Prove durable agent health, review schedules, budgets,
// waiting states, recovery and resumptions independent of worker
// lifetime." Acceptance: "worker/process failure does not terminate
// organizational actor state; review and lifecycle controls remain
// authoritative; budget and permissions survive resume."
//
// A worker's death is simulated the only honest way (the W080
// resumption-suite discipline): the durable state a dead supervisor
// leaves behind — an un-ledgered dispatched attempt, an unfired due
// review, a live-but-expired session lease, a suspension recorded but
// not yet enforced, a pending termination proposal — is crafted
// directly, and the dead session is never consulted again. A FRESH
// supervisor session — new worker, same database — must then recover
// and continue correctly:
//
//   1. worker death does not terminate actor state (the record,
//      budget, ceiling and schedule survive byte-for-byte; the dead
//      session is recovered durably; the fresh worker refuses to pump
//      under the dead session's identity);
//   2. the review schedule survives (a due review fires exactly once
//      under the fresh worker; completion re-arms the cadence);
//   3. budgets and permissions survive resume (spend is ledgered
//      exactly once per attempt across the restart — no double
//      count, no loss; the ceiling refuses the same scopes before and
//      after; exhaustion and its recovery work);
//   4. review and lifecycle controls remain authoritative (a
//      termination proposal defers to the W024 decision: applied →
//      terminated with live supervised work cancelled; refused → the
//      actor continues; a suspension's enforcement is itself
//      crash-recoverable and cancels only SUPERVISED work, through
//      the gateway's public contract);
//   5. health is durable (the observation and its evidence survive;
//      any worker recomputes the same health from the same evidence).

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
  getAgentExecution,
  listAgentExecutionAttempts,
  registerAgent,
  runAgentExecution,
  setAgentTransport,
  submitAgentExecution,
  type AgentPermissionScope,
  type AgentRuntimeTransport,
  type AgentRuntimeTransportReceipt,
  type AgentRuntimeTransportRequest,
} from '@/modules/agents/contract';
import { decideApproval } from '@/modules/actions/contract';
import {
  decideAgentLifecycle,
  recordAgentEvaluation,
  settleAgentLifecycleDecision,
} from '@/modules/agent-evaluation/contract';
import {
  beginSupervisorSession,
  completeSupervisionReview,
  getSupervision,
  getSupervisorSession,
  grantSupervisionBudget,
  listSupervisionBudgetEntries,
  listSupervisionEvents,
  observeSupervisedAgentHealth,
  pumpSupervision,
  registerSupervisedAgent,
  resumeSupervision,
  submitSupervisedExecution,
  suspendSupervision,
  type AgentSupervisionRecord,
} from '../contract';
import { AgentSupervisionError } from '../errors';
import { runMigrations } from '../../../../scripts/migrate';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const tenantRestart = newId();
const tenantSchedule = newId();
const tenantBudget = newId();
const tenantPermissions = newId();
const tenantTermination = newId();
const tenantRefusal = newId();
const tenantEnforcement = newId();
const tenantHealth = newId();

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

/** Separation of duties: a DIFFERENT principal approves gated actions. */
function approver(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: ['actions:approve', 'agents:administer'] };
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

/**
 * The runtime transport: delivers the canonical LangGraph dialect with
 * KNOWN usage (1_200 in / 800 out / 3 steps → exactly 1 minor unit per
 * successful attempt — registry pricing), or rejects the next count
 * dispatches (permanent refusals → terminally failed executions).
 */
class RecoveryTransport implements AgentRuntimeTransport {
  private rejectionsLeft = 0;

  rejectNext(count: number): void {
    this.rejectionsLeft = count;
  }

  async send(request: AgentRuntimeTransportRequest): Promise<AgentRuntimeTransportReceipt> {
    if (this.rejectionsLeft > 0) {
      this.rejectionsLeft -= 1;
      return { status: 'rejected', payload: null, providerTaskId: null, detail: 'policy refusal' };
    }
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

/** One delivered LangGraph attempt costs exactly 1 minor unit (250/1M in, 1000/1M out, 20/1K steps). */
const ATTEMPT_COST_MINOR = 1;

let transport: RecoveryTransport;

beforeAll(async () => {
  await runMigrations(getDb());
});

afterAll(async () => {
  setAgentTransport(null);
  await closeDb();
});

beforeEach(() => {
  setClock(BASE_TIME);
  transport = new RecoveryTransport();
  setAgentTransport(transport);
});

interface AgentFixture {
  agentId: string;
  supervision: AgentSupervisionRecord;
}

async function makeSupervisedAgent(
  tenantId: string,
  slug: string,
  options: {
    reviewIntervalSeconds?: number;
    healthIntervalSeconds?: number;
    budgetMinor?: number | null;
    permittedScopes?: AgentPermissionScope[];
  } = {},
): Promise<AgentFixture> {
  const ctx = admin(tenantId);
  const registered = await registerAgent(ctx, {
    slug,
    displayName: slug,
    role: 'operations',
    description: null,
    provider: 'langgraph',
    instructions: 'Do the supervised thing.',
    runtimeConfig: { assistantId: `asst_${slug}` },
    permissions: ['observe', 'analyze', 'recommend'],
  });
  const { supervision } = await registerSupervisedAgent(ctx, {
    agentId: registered.agent.id,
    reviewIntervalSeconds: options.reviewIntervalSeconds ?? 2_592_000,
    healthIntervalSeconds: options.healthIntervalSeconds ?? 2_592_000,
    budgetMinor: options.budgetMinor ?? null,
    permittedScopes: options.permittedScopes ?? ['observe', 'analyze', 'recommend'],
  });
  return { agentId: registered.agent.id, supervision };
}

/** Submit + dispatch one supervised execution (one successful attempt). */
async function dispatchSupervised(
  tenantId: string,
  agentId: string,
  key: string,
): Promise<string> {
  const execution = await submitSupervisedExecution(member(tenantId), {
    agentId,
    task: { duty: key },
    requestedPermissions: ['observe', 'analyze'],
    idempotencyKey: key,
  });
  await runAgentExecution(member(tenantId), { executionId: execution.id });
  return execution.id;
}

// ---------------------------------------------------------------------------
// 1. W098 ACCEPTANCE: worker death does not terminate actor state
// ---------------------------------------------------------------------------

describe('W098 acceptance: worker death does not terminate actor state', () => {
  it('recovers the dead session durably and resumes supervision from the identical durable state', async () => {
    const ctxAdmin = admin(tenantRestart);
    const { agentId } = await makeSupervisedAgent(tenantRestart, 'restart-analyst', {
      budgetMinor: 1_000,
      reviewIntervalSeconds: 3_600,
    });

    // Worker A: begin a session, submit and dispatch supervised work.
    const workerA = await beginSupervisorSession(ctxAdmin, { leaseSeconds: 60 });
    const executionId = await dispatchSupervised(tenantRestart, agentId, 'restart-1');

    // The dispatched attempt exists (W021 evidence) but is NOT yet
    // ledgered — the exact durable state a supervisor that died
    // between dispatch and accounting leaves behind.
    const attempts = await listAgentExecutionAttempts(member(tenantRestart), { executionId });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.costMinor).toBe(ATTEMPT_COST_MINOR);

    const beforeDeath = await getSupervision(ctxAdmin, { agentId });
    expect(beforeDeath.status).toBe('active');
    expect(beforeDeath.budgetSpentMinor).toBe(0);

    // --- worker A DIES: its lease lapses, it never pumps again. ---
    advance(90);

    // The dead session's identity may not drive work.
    await expectCode('session_not_live', () =>
      pumpSupervision(ctxAdmin, { agentId, sessionId: workerA.id }),
    );

    // Worker B: a FRESH session on the same database recovers A.
    const workerB = await beginSupervisorSession(ctxAdmin, { leaseSeconds: 60 });
    const deadRow = await getSupervisorSession(ctxAdmin, { sessionId: workerA.id });
    expect(deadRow.endReason).toBe('lease_expired_recovered');
    expect(deadRow.recoveredBySessionId).toBe(workerB.id);

    const recoveryEvents = await listSupervisionEvents(ctxAdmin, { sessionId: workerA.id });
    expect(recoveryEvents.map((event) => event.kind)).toContain('session_recovered');

    // The actor state survived the death byte-for-byte.
    const afterRecovery = await getSupervision(ctxAdmin, { agentId });
    expect(afterRecovery.status).toBe('active');
    expect(afterRecovery.budgetMinor).toBe(beforeDeath.budgetMinor);
    expect(afterRecovery.permittedScopes).toEqual(beforeDeath.permittedScopes);
    expect(afterRecovery.nextReviewAt).toBe(beforeDeath.nextReviewAt);
    expect(afterRecovery.ownerPrincipal).toBe(beforeDeath.ownerPrincipal);

    // The fresh worker resumes the accounting: the dead worker's
    // dispatched attempt is ledgered EXACTLY ONCE.
    const outcome = await pumpSupervision(ctxAdmin, { agentId, sessionId: workerB.id });
    expect(outcome.status).toBe('budget_consumed');
    const resumed = await getSupervision(ctxAdmin, { agentId });
    expect(resumed.budgetSpentMinor).toBe(ATTEMPT_COST_MINOR);

    // Re-pumping does not double-count (the pump is idempotent per
    // attempt — the UNIQUE ledger key).
    await pumpSupervision(ctxAdmin, { agentId, sessionId: workerB.id }); // health/idle
    const entries = await listSupervisionBudgetEntries(ctxAdmin, { agentId });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.attemptId).toBe(attempts[0]!.id);
    expect((await getSupervision(ctxAdmin, { agentId })).budgetSpentMinor).toBe(
      ATTEMPT_COST_MINOR,
    );
  });
});

// ---------------------------------------------------------------------------
// 2. W098 ACCEPTANCE: the review schedule survives worker lifetime
// ---------------------------------------------------------------------------

describe('W098 acceptance: review schedules survive worker lifetime', () => {
  it('fires a due review exactly once under the fresh worker and re-arms the cadence', async () => {
    const ctxAdmin = admin(tenantSchedule);
    const { agentId } = await makeSupervisedAgent(tenantSchedule, 'schedule-analyst', {
      reviewIntervalSeconds: 60,
    });

    // Worker A sets up the schedule, then dies BEFORE the review fires.
    const workerA = await beginSupervisorSession(ctxAdmin, { leaseSeconds: 60 });
    expect(workerA.id).toBeDefined();
    advance(180); // the cursor lapses; A's lease dies with it

    // Worker B recovers and fires the due review exactly once.
    const workerB = await beginSupervisorSession(ctxAdmin, { leaseSeconds: 60 });
    const fired = await pumpSupervision(ctxAdmin, { agentId, sessionId: workerB.id });
    expect(fired.status).toBe('review_due');
    expect(fired.supervisionStatus).toBe('waiting_review');

    const duplicate = await pumpSupervision(ctxAdmin, { agentId, sessionId: workerB.id });
    expect(duplicate.status).not.toBe('review_due');

    const events = await listSupervisionEvents(ctxAdmin, { agentId, kind: 'review_due' });
    expect(events).toHaveLength(1);
    expect(events[0]!.sessionId).toBe(workerB.id);

    // The review authority completes it; the cadence re-arms.
    const review = await completeSupervisionReview(ctxAdmin, {
      agentId,
      outcome: 'continue',
      rationale: 'actor performs within expectations',
    });
    expect(review.outcome).toBe('continue');
    const after = await getSupervision(ctxAdmin, { agentId });
    expect(after.status).toBe('active');
    expect(after.reviewCount).toBe(1);
    expect(Date.parse(after.nextReviewAt)).toBe(clockMs + 60_000);
  });
});

// ---------------------------------------------------------------------------
// 3. W098 ACCEPTANCE: budgets and permissions survive resume
// ---------------------------------------------------------------------------

describe('W098 acceptance: budgets survive resume', () => {
  it('ledgers spend exactly once per attempt across the restart and pauses on exhaustion', async () => {
    const ctxAdmin = admin(tenantBudget);
    const ctxMember = member(tenantBudget);
    const { agentId } = await makeSupervisedAgent(tenantBudget, 'budget-analyst', {
      budgetMinor: 2 * ATTEMPT_COST_MINOR,
    });

    // Worker A dispatches THREE supervised executions (one attempt
    // each) — the spend that will overshoot the envelope — then dies
    // before ledgering ANY of them.
    await beginSupervisorSession(ctxAdmin, { leaseSeconds: 60 });
    const executionIds = [
      await dispatchSupervised(tenantBudget, agentId, 'budget-1'),
      await dispatchSupervised(tenantBudget, agentId, 'budget-2'),
      await dispatchSupervised(tenantBudget, agentId, 'budget-3'),
    ];
    advance(90); // death

    // Worker B recovers and pumps the accounting to completion.
    const workerB = await beginSupervisorSession(ctxAdmin, { leaseSeconds: 60 });
    const statuses: string[] = [];
    for (let i = 0; i < 8; i += 1) {
      const outcome = await pumpSupervision(ctxAdmin, { agentId, sessionId: workerB.id });
      statuses.push(outcome.status);
      if (outcome.status === 'idle') break;
    }

    // Exactly three ledger units (one per attempt), in chronological
    // order — no double count from the restart, no lost spend.
    const entries = await listSupervisionBudgetEntries(ctxAdmin, { agentId });
    expect(entries).toHaveLength(3);
    const expectedAttempts = (
      await Promise.all(
        executionIds.map((id) => listAgentExecutionAttempts(ctxMember, { executionId: id })),
      )
    )
      .flat()
      .map((attempt) => attempt.id);
    expect(new Set(entries.map((entry) => entry.attemptId))).toEqual(
      new Set(expectedAttempts),
    );

    // The overshoot is ledgered faithfully (3 > 2) and the exhaustion
    // fired: the actor waits in paused_budget.
    expect(statuses.filter((status) => status === 'budget_consumed')).toHaveLength(3);
    expect(statuses).toContain('budget_exhausted');
    const paused = await getSupervision(ctxAdmin, { agentId });
    expect(paused.status).toBe('paused_budget');
    expect(paused.budgetSpentMinor).toBe(3 * ATTEMPT_COST_MINOR);
    expect(paused.budgetRemainingMinor).toBe(0);

    // Admission refuses while paused.
    await expectCode('not_active', () =>
      submitSupervisedExecution(ctxMember, {
        agentId,
        task: { duty: 'x' },
        requestedPermissions: ['observe'],
      }),
    );

    // The budget grant is the waiting state's recovery authority.
    const granted = await grantSupervisionBudget(ctxAdmin, {
      agentId,
      additionalMinor: 10 * ATTEMPT_COST_MINOR,
    });
    expect(granted.status).toBe('active');
    expect(granted.budgetRemainingMinor).toBe(9 * ATTEMPT_COST_MINOR);
    const resumedEvents = await listSupervisionEvents(ctxAdmin, { agentId });
    expect(resumedEvents.map((event) => event.kind)).toContain('budget_resumed');
  });
});

describe('W098 acceptance: permissions survive resume', () => {
  it('enforces the same permission ceiling before and after the restart', async () => {
    const ctxAdmin = admin(tenantPermissions);
    const ctxMember = member(tenantPermissions);
    const { agentId } = await makeSupervisedAgent(tenantPermissions, 'perm-analyst', {
      permittedScopes: ['observe', 'analyze'],
    });

    // Before the crash: the ceiling refuses 'recommend' even though the
    // agent's W021 GRANT includes it (the ceiling is the supervision
    // control; the grant check is the gateway's).
    await expectCode('scope_not_permitted', () =>
      submitSupervisedExecution(ctxMember, {
        agentId,
        task: { duty: 'x' },
        requestedPermissions: ['observe', 'recommend'],
      }),
    );

    // The worker dies and a fresh one recovers.
    await beginSupervisorSession(ctxAdmin, { leaseSeconds: 60 });
    advance(90);
    const workerB = await beginSupervisorSession(ctxAdmin, { leaseSeconds: 60 });
    await pumpSupervision(ctxAdmin, { agentId, sessionId: workerB.id });

    // After the resume: the IDENTICAL refusal and the identical grant.
    await expectCode('scope_not_permitted', () =>
      submitSupervisedExecution(ctxMember, {
        agentId,
        task: { duty: 'x' },
        requestedPermissions: ['recommend'],
      }),
    );
    const admitted = await submitSupervisedExecution(ctxMember, {
      agentId,
      task: { duty: 'fine' },
      requestedPermissions: ['observe', 'analyze'],
      idempotencyKey: 'perm-after-resume',
    });
    expect(admitted.status).toBe('queued');
    const ceiling = await getSupervision(ctxAdmin, { agentId });
    expect(admitted.causationId).toBe(`agent-supervision:${ceiling.id}`);
    expect(ceiling.permittedScopes).toEqual(['observe', 'analyze']);
    expect(ceiling.status).toBe('active');
  });
});

// ---------------------------------------------------------------------------
// 4. W098 ACCEPTANCE: review and lifecycle controls remain authoritative
// ---------------------------------------------------------------------------

describe('W098 acceptance: lifecycle controls remain authoritative (termination)', () => {
  it('defers to the W024 decision: applied → terminated with live work cancelled', async () => {
    const ctxAdmin = admin(tenantTermination);
    const ctxApprover = approver(tenantTermination);
    const { agentId } = await makeSupervisedAgent(tenantTermination, 'terminal-analyst', {
      reviewIntervalSeconds: 60,
    });

    // Live supervised work in flight (stays queued — no dispatch).
    const liveExecution = await submitSupervisedExecution(member(tenantTermination), {
      agentId,
      task: { duty: 'long-running' },
      requestedPermissions: ['observe'],
      idempotencyKey: 'terminal-live',
    });

    // The W024 evidence chain: evaluation → gated terminate decision.
    const evaluation = await recordAgentEvaluation(ctxAdmin, {
      agentId,
      replacementOptions: [
        {
          kind: 'eliminate',
          summary: 'the supervised duty is obsolete',
          estimatedCostMinor: 0,
          estimatedCostCurrency: 'USD',
        },
      ],
    });
    const decision = await decideAgentLifecycle(ctxAdmin, {
      evaluationId: evaluation.id,
      change: 'terminate',
      rationale: 'measured outcomes justify termination',
    });
    // The built-in default gates agent-termination behind a human.
    expect(decision.status).toBe('awaiting_approval');

    // The review proposes termination, citing the decision.
    advance(61);
    await pumpSupervision(ctxAdmin, { agentId });
    await completeSupervisionReview(ctxAdmin, {
      agentId,
      outcome: 'terminate_proposal',
      rationale: 'measured evidence says stop',
      decisionId: decision.id,
    });
    const waiting = await getSupervision(ctxAdmin, { agentId });
    expect(waiting.status).toBe('waiting_termination');
    expect(waiting.terminationDecisionId).toBe(decision.id);

    // While the decision is pending, the pump does NOT terminate and
    // no supervised work is admitted.
    await pumpSupervision(ctxAdmin, { agentId });
    expect((await getSupervision(ctxAdmin, { agentId })).status).toBe('waiting_termination');
    await expectCode('not_active', () =>
      submitSupervisedExecution(member(tenantTermination), {
        agentId,
        task: { duty: 'x' },
        requestedPermissions: ['observe'],
      }),
    );

    // --- the worker dies mid-wait; a fresh one recovers. ---
    advance(90);
    const workerB = await beginSupervisorSession(ctxAdmin, { leaseSeconds: 60 });

    // The human approves; W024's settlement applies it (the agent
    // definition is disabled through the agents contract).
    await decideApproval(ctxApprover, {
      requestId: decision.policy!.actionRequestId,
      decision: 'approve',
    });
    const settled = await settleAgentLifecycleDecision(ctxApprover, { decisionId: decision.id });
    expect(settled.status).toBe('applied');

    // The fresh supervisor settles the actor from the AUTHORITATIVE
    // decision — not from its own judgement.
    const settledOutcome = await pumpSupervision(ctxAdmin, { agentId, sessionId: workerB.id });
    expect(settledOutcome.status).toBe('termination_settled');
    expect(settledOutcome.supervisionStatus).toBe('terminated');
    const terminated = await getSupervision(ctxAdmin, { agentId });
    expect(terminated.terminationDecisionId).toBe(decision.id);

    // Enforcement cancels the live SUPERVISED execution (one per pump).
    const enforce = await pumpSupervision(ctxAdmin, { agentId, sessionId: workerB.id });
    expect(enforce.status).toBe('live_work_cancelled');
    const cancelled = await getAgentExecution(member(tenantTermination), {
      executionId: liveExecution.id,
    });
    expect(cancelled.status).toBe('cancelled');

    // Terminal is history: no admission, no resurrection.
    await expectCode('not_active', () =>
      submitSupervisedExecution(member(tenantTermination), {
        agentId,
        task: { duty: 'x' },
        requestedPermissions: ['observe'],
      }),
    );
    await expectCode('invalid_transition', () =>
      resumeSupervision(ctxAdmin, { agentId }),
    );
  });

  it('returns the actor to duty when the W024 decision is refused', async () => {
    const ctxAdmin = admin(tenantRefusal);
    const ctxApprover = approver(tenantRefusal);
    const { agentId } = await makeSupervisedAgent(tenantRefusal, 'refused-analyst', {
      reviewIntervalSeconds: 60,
    });

    const evaluation = await recordAgentEvaluation(ctxAdmin, {
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
    const decision = await decideAgentLifecycle(ctxAdmin, {
      evaluationId: evaluation.id,
      change: 'terminate',
      rationale: 'proposed but refused',
    });
    advance(61);
    await pumpSupervision(ctxAdmin, { agentId });
    await completeSupervisionReview(ctxAdmin, {
      agentId,
      outcome: 'terminate_proposal',
      rationale: 'propose stopping',
      decisionId: decision.id,
    });
    expect((await getSupervision(ctxAdmin, { agentId })).status).toBe('waiting_termination');

    // The human REFUSES the termination; W024's settlement records it.
    await decideApproval(ctxApprover, {
      requestId: decision.policy!.actionRequestId,
      decision: 'reject',
    });
    const settled = await settleAgentLifecycleDecision(ctxApprover, { decisionId: decision.id });
    expect(settled.status).toBe('refused');

    const outcome = await pumpSupervision(ctxAdmin, { agentId });
    expect(outcome.status).toBe('termination_settled');
    expect(outcome.supervisionStatus).toBe('active');
    const resumed = await getSupervision(ctxAdmin, { agentId });
    expect(resumed.terminationDecisionId).toBeNull();
    expect(Date.parse(resumed.nextReviewAt)).toBe(clockMs + 60_000);

    // The actor works again under the same supervision contract.
    const execution = await submitSupervisedExecution(member(tenantRefusal), {
      agentId,
      task: { duty: 'back to work' },
      requestedPermissions: ['observe'],
    });
    expect(execution.status).toBe('queued');
  });
});

describe('W098 acceptance: suspension enforcement is crash-recoverable and scoped', () => {
  it('cancels only supervised live work, after a crash, through the public gateway contract', async () => {
    const ctxAdmin = admin(tenantEnforcement);
    const ctxMember = member(tenantEnforcement);
    const { agentId } = await makeSupervisedAgent(tenantEnforcement, 'enforce-analyst');

    // One SUPERVISED and one UNSUPERVISED live execution.
    const supervisedExecution = await submitSupervisedExecution(ctxMember, {
      agentId,
      task: { duty: 'supervised' },
      requestedPermissions: ['observe'],
      idempotencyKey: 'enforce-supervised',
    });
    const unsupervisedExecution = await submitAgentExecution(ctxMember, {
      agentId,
      task: { duty: 'direct gateway submission' },
      requestedPermissions: ['observe'],
    });
    expect(unsupervisedExecution.causationId).toBeNull();

    // Management suspends: the transition lands (authoritative), and
    // the enforcement is a bounded pump unit — the worker then DIES
    // before running it.
    await suspendSupervision(ctxAdmin, { agentId, reason: 'pending investigation' });
    advance(90); // death

    // A fresh worker recovers and completes the enforcement.
    const workerB = await beginSupervisorSession(ctxAdmin, { leaseSeconds: 60 });
    const enforced = await pumpSupervision(ctxAdmin, { agentId, sessionId: workerB.id });
    expect(enforced.status).toBe('live_work_cancelled');

    const cancelled = await getAgentExecution(ctxMember, {
      executionId: supervisedExecution.id,
    });
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.errorCode).toBe('cancelled');

    // The unsupervised execution is NOT supervision's to cancel.
    const untouched = await getAgentExecution(ctxMember, {
      executionId: unsupervisedExecution.id,
    });
    expect(untouched.status).toBe('queued');

    // Admission refuses while suspended; resume recovers.
    await expectCode('not_active', () =>
      submitSupervisedExecution(ctxMember, {
        agentId,
        task: { duty: 'x' },
        requestedPermissions: ['observe'],
      }),
    );
    const resumed = await resumeSupervision(ctxAdmin, { agentId, note: 'investigation closed' });
    expect(resumed.status).toBe('active');
  });
});

// ---------------------------------------------------------------------------
// 5. W098 ACCEPTANCE: durable health
// ---------------------------------------------------------------------------

describe('W098 acceptance: durable health', () => {
  it('survives the worker death and recomputes identically from the same evidence', async () => {
    const ctxAdmin = admin(tenantHealth);
    const ctxMember = member(tenantHealth);
    const { agentId } = await makeSupervisedAgent(tenantHealth, 'health-analyst');

    // Three terminally failed executions (permanent runtime refusals).
    transport.rejectNext(3);
    for (const key of ['health-1', 'health-2', 'health-3']) {
      const execution = await submitSupervisedExecution(ctxMember, {
        agentId,
        task: { duty: key },
        requestedPermissions: ['observe'],
        idempotencyKey: key,
      });
      await runAgentExecution(ctxMember, { executionId: execution.id });
    }

    const observed = await observeSupervisedAgentHealth(ctxAdmin, { agentId });
    expect(observed.healthState).toBe('unhealthy'); // 3/3 decided failed
    expect(observed.healthDetail).toContain('3/3 decided failed');

    // --- the worker dies; a fresh one recovers. ---
    advance(90);
    const workerB = await beginSupervisorSession(ctxAdmin, { leaseSeconds: 60 });
    await pumpSupervision(ctxAdmin, { agentId, sessionId: workerB.id });

    // The health observation survived the death unchanged.
    const after = await getSupervision(ctxAdmin, { agentId });
    expect(after.healthState).toBe('unhealthy');
    expect(after.healthDetail).toBe(observed.healthDetail);
    expect(after.healthObservedAt).toBe(observed.healthObservedAt);

    // The health evidence trail is append-only — three observations
    // would exist only if re-observed; the durable one stands.
    const events = await listSupervisionEvents(ctxAdmin, { agentId, kind: 'health_observed' });
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toMatchObject({ state: 'unhealthy' });
  });
});
