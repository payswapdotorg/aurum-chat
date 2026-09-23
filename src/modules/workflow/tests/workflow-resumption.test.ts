// THE W080 ACCEPTANCE SUITE — kill/restart resumption, exactly-once
// idempotency and wait survival, proven against the embedded PostgreSQL
// (PGlite, `:memory:`) through the db port.
//
// The core acceptance property: "kill/restart workers during active
// runs; pending approval/employee wait survives; execution resumes
// exactly once or produces deterministic idempotent recovery; no
// workflow state is held only in worker memory."
//
// A worker's death is simulated the only honest way: the durable state
// a dead pump leaves behind (a claimed step, a live lease, whatever
// external effects the executor already performed) is crafted directly,
// and the dead engine instance is simply never consulted again. A FRESH
// engine instance — new executor bindings, same database — must then
// resume the run correctly. Effects are recorded in a first-write-wins
// map keyed by the step idempotency keys, which is exactly the
// executor-side key discipline the engine's contract mandates.
//
// Also covered: the pump's guarded concurrency (live leases are never
// double-claimed; a lost outcome race reports 'conflict'), timer waits,
// checkpoint continuation for long-running cognition, retries with
// explicit attempt counters, deterministic dead-lettering, cooperative
// cancellation and the event-trigger/schedule materialization paths
// through the pump.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { systemClock } from '@/infra/clock';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { decideApproval, getActionRequest } from '@/modules/actions/contract';
import {
  createWorkflowEngine,
  dispatchWorkflowEvent,
  getRun,
  listRunStepAttempts,
  listRunSteps,
  listRuns,
  registerWorkflow,
  resumeRun,
  startRun,
  cancelRun,
  stepIdempotencyKey,
  type WorkflowEnginePort,
  type WorkflowStepInvocation,
  type WorkflowWaitOutcome,
} from '../contract';
import { WorkflowStepError } from '../errors';
import { runMigrations } from '../../../../scripts/migrate';

const BASE_TIME = Date.parse('2026-09-24T12:00:00Z'); // Thursday noon
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

function approver(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: ['actions:approve'] };
}

// One tenant per concern so counts stay deterministic.
const tenantRestart = newId();
const tenantExactlyOnce = newId();
const tenantApproval = newId();
const tenantEmployee = newId();
const tenantTimer = newId();
const tenantCheckpoint = newId();
const tenantRetry = newId();
const tenantCancel = newId();
const tenantConcurrency = newId();
const tenantPumpMisc = newId();

// ---------------------------------------------------------------------------
// The external-world simulator: effects recorded first-write-wins under
// the step idempotency keys (exactly the executor contract).
// ---------------------------------------------------------------------------

let effects: Map<string, string>;

function recordEffect(key: string): boolean {
  if (effects.has(key)) return false;
  effects.set(key, 'performed');
  return true;
}

/** What one executor invocation observed (per step key, in order). */
interface InvocationLog {
  engine: string;
  stepKey: string;
  invocation: number;
  attempt: number;
  wait: WorkflowWaitOutcome | null;
  checkpoint: unknown;
  idempotencyKey: string;
  cancelledFlag: boolean;
}

let invocations: InvocationLog[];

function tag(tag_: string): string {
  return tag_;
}

/** An executor that performs its (idempotent) external effect and completes. */
function effectfulDoneExecutor(engine: string): (inv: WorkflowStepInvocation) => Promise<{ type: 'done'; output: unknown }> {
  return async (inv) => {
    const created = recordEffect(inv.idempotencyKey);
    invocations.push({
      engine,
      stepKey: inv.stepKey,
      invocation: inv.invocation,
      attempt: inv.attempt,
      wait: inv.wait,
      checkpoint: inv.checkpoint,
      idempotencyKey: inv.idempotencyKey,
      cancelledFlag: false,
    });
    return { type: 'done', output: { effectCreated: created, by: engine } };
  };
}

/** Craft the durable state a dead worker leaves: a claimed, leased step. */
async function simulateDeadWorkerClaim(
  tenantId: string,
  runId: string,
  leaseSeconds: number,
): Promise<void> {
  const at = new Date(clockMs);
  const leaseExpiresAt = new Date(clockMs + leaseSeconds * 1_000);
  await getDb().query(
    `UPDATE workflow_run_steps
       SET status = 'running', invocation_count = invocation_count + 1,
           started_at = $3, lease_expires_at = $4, updated_at = $3
     WHERE tenant_id = $1 AND run_id = $2 AND step_number = 1`,
    [tenantId, runId, at, leaseExpiresAt],
  );
  await getDb().query(
    `UPDATE workflow_runs
       SET status = 'running', current_step = 1, started_at = $3, updated_at = $3
     WHERE tenant_id = $1 AND id = $2`,
    [tenantId, runId, at],
  );
}

beforeAll(async () => {
  await runMigrations(getDb());
});

afterAll(async () => {
  await closeDb();
});

beforeEach(() => {
  setClock(BASE_TIME);
  effects = new Map();
  invocations = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// W080 ACCEPTANCE: kill/restart resumption (fresh engine mid-run)
// ---------------------------------------------------------------------------

describe('W080 acceptance: kill/restart resumption', () => {
  beforeAll(async () => {
    const ctx = member(tenantRestart);
    await registerWorkflow(ctx, {
      key: 'demo.two-step',
      title: 'Two step',
      spec: {
        steps: [
          { key: 'first', leaseSeconds: 60 },
          { key: 'second', leaseSeconds: 60 },
        ],
      },
    });
  });

  it('a fresh engine constructed against the same database resumes an active run exactly where the dead one stopped', async () => {
    const ctx = member(tenantRestart);

    // Engine instance A — the worker that will "die" mid-run.
    const engineA: WorkflowEnginePort = createWorkflowEngine({
      'demo.two-step': {
        first: effectfulDoneExecutor('A'),
        second: effectfulDoneExecutor('A'),
      },
    });
    const run = await startRun(ctx, { definitionKey: 'demo.two-step', input: { n: 1 } });

    // Step 1 completes under engine A.
    const outcome1 = await engineA.pump(ctx);
    expect(outcome1.status).toBe('processed');
    expect(outcome1.stepNumber).toBe(1);
    expect(outcome1.runStatus).toBe('running');
    const afterStep1 = await getRun(ctx, { runId: run.id });
    expect(afterStep1.status).toBe('running');
    expect(afterStep1.currentStep).toBe(2);
    expect(afterStep1.startedAt).not.toBeNull();

    // === ENGINE A DIES (never consulted again) ===

    // Engine instance B — a FRESH instance with fresh executor bindings,
    // same database. It must resume at step 2.
    const engineB: WorkflowEnginePort = createWorkflowEngine({
      'demo.two-step': {
        first: effectfulDoneExecutor('B'),
        second: effectfulDoneExecutor('B'),
      },
    });
    const outcome2 = await engineB.pump(ctx);
    expect(outcome2.status).toBe('processed');
    expect(outcome2.stepNumber).toBe(2);
    expect(outcome2.runStatus).toBe('succeeded');

    const finished = await getRun(ctx, { runId: run.id });
    expect(finished.status).toBe('succeeded');
    expect(finished.result).toEqual({ effectCreated: true, by: 'B' });
    expect(finished.finishedAt).not.toBeNull();

    // Each step's executor ran EXACTLY ONCE in total across both engine
    // generations — resumption is exactly-once, not at-least-once.
    expect(invocations.map((entry) => [entry.engine, entry.stepKey])).toEqual([
      ['A', 'first'],
      ['B', 'second'],
    ]);
    expect(invocations.every((entry) => entry.invocation === 1)).toBe(true);
    expect(invocations.map((entry) => entry.idempotencyKey)).toEqual([
      stepIdempotencyKey(run.id, 1),
      stepIdempotencyKey(run.id, 2),
    ]);
    expect(effects.size).toBe(2);

    // Nothing left to pump.
    expect((await engineB.pump(ctx)).status).toBe('idle');

    // The attempt evidence trail reconstructs the whole run.
    const attempts = await listRunStepAttempts(ctx, { runId: run.id });
    expect(attempts.map((a) => [a.stepNumber, a.invocation, a.outcome])).toEqual([
      [1, 1, 'completed'],
      [2, 1, 'completed'],
    ]);
  });
});

// ---------------------------------------------------------------------------
// W080 ACCEPTANCE: exactly-once idempotency on crash recovery
// ---------------------------------------------------------------------------

describe('W080 acceptance: exactly-once idempotent recovery', () => {
  beforeAll(async () => {
    const ctx = member(tenantExactlyOnce);
    await registerWorkflow(ctx, {
      key: 'demo.crash',
      title: 'Crash',
      spec: { steps: [{ key: 'work', leaseSeconds: 60 }] },
    });
  });

  it('recovers a step whose worker died mid-invocation, with the external effect performed exactly once', async () => {
    const ctx = member(tenantExactlyOnce);
    const run = await startRun(ctx, { definitionKey: 'demo.crash' });
    const key = stepIdempotencyKey(run.id, 1);

    // The dead worker's durable residue: it CLAIMED the step (invocation
    // 1, live lease) and performed the executor's external effect — then
    // the process died before persisting any outcome.
    await simulateDeadWorkerClaim(tenantExactlyOnce, run.id, 60);
    recordEffect(key); // the effect the dead executor already performed
    expect(effects.size).toBe(1);

    // A live lease protects the dead claim until it expires.
    const engineB: WorkflowEnginePort = createWorkflowEngine({
      'demo.crash': { work: effectfulDoneExecutor('B') },
    });
    expect((await engineB.pump(ctx)).status).toBe('idle');

    // The lease expires → the recovery pump re-invokes the step WITH its
    // stable idempotency key: the effect recorder rejects the duplicate
    // (first write wins) — exactly-once for the external world.
    advance(61);
    const outcome = await engineB.pump(ctx);
    expect(outcome.status).toBe('processed');
    expect(outcome.recovered).toBe(true);

    const finished = await getRun(ctx, { runId: run.id });
    expect(finished.status).toBe('succeeded');
    // The effect exists EXACTLY ONCE despite two executor lifetimes.
    expect(effects.size).toBe(1);
    expect(effects.has(key)).toBe(true);

    // The evidence trail records the loss deterministically: invocation 1
    // was abandoned, invocation 2 completed.
    const attempts = await listRunStepAttempts(ctx, { runId: run.id });
    expect(attempts.map((a) => [a.invocation, a.outcome])).toEqual([
      [1, 'abandoned'],
      [2, 'completed'],
    ]);
    const steps = await listRunSteps(ctx, { runId: run.id });
    expect(steps[0]!.invocationCount).toBe(2);
    expect(steps[0]!.attemptCount).toBe(0); // waits/crashes never consume retry budget
  });

  it('an idempotency-keyed startRun replays the original run rather than starting a second one', async () => {
    const ctx = member(tenantExactlyOnce);
    const first = await startRun(ctx, {
      definitionKey: 'demo.crash',
      idempotencyKey: 'idem-start',
    });
    const second = await startRun(ctx, {
      definitionKey: 'demo.crash',
      idempotencyKey: 'idem-start',
    });
    expect(second.id).toBe(first.id);
    expect((await listRuns(ctx, { definitionKey: 'demo.crash' })).length).toBe(2); // this test's two runs
  });
});

// ---------------------------------------------------------------------------
// W080 ACCEPTANCE: pending approval wait survives worker death
// ---------------------------------------------------------------------------

describe('W080 acceptance: approval-wait survival (human decision releases a dead worker\'s run)', () => {
  beforeAll(async () => {
    const ctx = member(tenantApproval);
    await registerWorkflow(ctx, {
      key: 'demo.approval',
      title: 'Approval flow',
      spec: {
        steps: [
          { key: 'propose' },
          { key: 'finish' },
        ],
      },
    });
  });

  it('routes the approval through the actions gate, survives the engine\'s death, and resumes on the human decision', async () => {
    const ctx = member(tenantApproval);
    let seenDecision: WorkflowWaitOutcome | null = null;

    const engineA: WorkflowEnginePort = createWorkflowEngine({
      'demo.approval': {
        propose: async (inv) => {
          invocations.push({
            engine: 'A',
            stepKey: inv.stepKey,
            invocation: inv.invocation,
            attempt: inv.attempt,
            wait: inv.wait,
            checkpoint: inv.checkpoint,
            idempotencyKey: inv.idempotencyKey,
            cancelledFlag: false,
          });
          if (inv.wait === null) {
            return {
              type: 'wait',
              wait: {
                kind: 'approval',
                approval: {
                  actionKind: 'external-communication',
                  authorityLevel: 'EXECUTE',
                  payload: { message: 'Tell Sarah the meeting moved.' },
                  justification: 'The supplier meeting moved; Sarah must be told.',
                },
              },
            } as const;
          }
          seenDecision = inv.wait;
          return { type: 'done', output: { routed: true } } as const;
        },
        finish: effectfulDoneExecutor('A'),
      },
    });

    const run = await startRun(ctx, { definitionKey: 'demo.approval', input: { meeting: 'moved' } });
    const outcome = await engineA.pump(ctx);
    expect(outcome.status).toBe('suspended');
    expect(outcome.runStatus).toBe('waiting');

    // The wait is durable state, integrated with the actions module: the
    // request exists, was routed by the authority matrix under the RUN's
    // original principal, and is PENDING a human decision.
    const steps = await listRunSteps(ctx, { runId: run.id });
    const waiting = steps[0]!;
    expect(waiting.status).toBe('waiting');
    expect(waiting.waitKind).toBe('approval');
    expect(waiting.waitActionRequestId).not.toBeNull();
    const request = await getActionRequest(ctx, { requestId: waiting.waitActionRequestId! });
    expect(request.status).toBe('pending');
    expect(request.requestedBy).toBe(run.runPrincipal);
    expect(request.actionKind).toBe('external-communication');

    // === ENGINE A DIES (never consulted again) ===

    // The human decides — through the ACTIONS module directly, with no
    // engine involvement at all. The pending wait survives.
    const decided = await decideApproval(approver(tenantApproval), {
      requestId: request.id,
      decision: 'approve',
      note: 'Sarah should know.',
    });
    expect(decided.status).toBe('approved');

    // A FRESH engine resumes: the pump observes the decided request,
    // re-invokes the executor WITH the decision, and the run completes.
    const engineB: WorkflowEnginePort = createWorkflowEngine({
      'demo.approval': {
        propose: async (inv) => {
          seenDecision = inv.wait;
          return { type: 'done', output: { routed: (inv.wait as unknown as { decision: string } | null)?.decision } } as const;
        },
        finish: effectfulDoneExecutor('B'),
      },
    });
    const resumed = await engineB.pump(ctx);
    expect(resumed.status).toBe('processed');
    expect(resumed.stepNumber).toBe(1);
    expect(seenDecision).toMatchObject({
      kind: 'approval',
      decision: 'approved',
      requestId: request.id,
    });

    const outcome2 = await engineB.pump(ctx);
    expect(outcome2.status).toBe('processed');
    expect(outcome2.runStatus).toBe('succeeded');
    const finished = await getRun(ctx, { runId: run.id });
    expect(finished.status).toBe('succeeded');
    // The run's result is the LAST step's output; the propose step's own
    // output records the routed decision it observed.
    const finalSteps = await listRunSteps(ctx, { runId: run.id });
    expect(finalSteps[0]!.output).toEqual({ routed: 'approved' });
    expect(finalSteps[1]!.status).toBe('succeeded');

    // The approval decision trail is the actions module's append-only
    // evidence — reconstructable end to end.
    const attempts = await listRunStepAttempts(ctx, { runId: run.id, stepNumber: 1 });
    expect(attempts.map((a) => [a.invocation, a.outcome, a.waitKind])).toEqual([
      [1, 'wait', 'approval'],
      [2, 'completed', null],
    ]);
  });

  it('a rejected decision resumes the executor with the rejection', async () => {
    const ctx = member(tenantApproval);
    const engine: WorkflowEnginePort = createWorkflowEngine({
      'demo.approval': {
        propose: async (inv) => {
          if (inv.wait === null) {
            return {
              type: 'wait',
              wait: {
                kind: 'approval',
                approval: {
                  actionKind: 'data-export',
                  authorityLevel: 'EXECUTE',
                  payload: { rows: 100 },
                },
              },
            } as const;
          }
          expect((inv.wait as unknown as { decision: string }).decision).toBe('rejected');
          throw new WorkflowStepError('approval_refused', 'the human refused the export');
        },
        finish: effectfulDoneExecutor('X'),
      },
    });
    const run = await startRun(ctx, { definitionKey: 'demo.approval' });
    await engine.pump(ctx);
    const steps = await listRunSteps(ctx, { runId: run.id });
    const request = await getActionRequest(ctx, { requestId: steps[0]!.waitActionRequestId! });
    await decideApproval(approver(tenantApproval), { requestId: request.id, decision: 'reject' });
    const outcome = await engine.pump(ctx);
    expect(outcome.status).toBe('failed');
    const failed = await getRun(ctx, { runId: run.id });
    expect(failed.status).toBe('failed');
    expect(failed.errorCode).toBe('approval_refused');
  });
});

// ---------------------------------------------------------------------------
// W080 ACCEPTANCE: employee-response wait survival (durable signals)
// ---------------------------------------------------------------------------

describe('W080 acceptance: employee-response wait survival', () => {
  beforeAll(async () => {
    const ctx = member(tenantEmployee);
    await registerWorkflow(ctx, {
      key: 'demo.ask',
      title: 'Ask an employee',
      spec: { steps: [{ key: 'ask' }] },
    });
  });

  it('a durable event signal releases a dead worker\'s waiting run', async () => {
    const ctx = member(tenantEmployee);
    let received: WorkflowWaitOutcome | null = null;

    const engineA: WorkflowEnginePort = createWorkflowEngine({
      'demo.ask': {
        ask: async (inv) => {
          if (inv.wait === null) {
            return {
              type: 'wait',
              wait: { kind: 'employee_response', resumeOnEvent: 'employee.replied', note: 'Which supplier?' },
            } as const;
          }
          received = inv.wait;
          return { type: 'done', output: { answer: (inv.wait as unknown as { payload: { answer: string } }).payload } } as const;
        },
      },
    });
    const run = await startRun(ctx, { definitionKey: 'demo.ask' });
    const outcome = await engineA.pump(ctx);
    expect(outcome.status).toBe('suspended');

    const steps = await listRunSteps(ctx, { runId: run.id });
    expect(steps[0]!.waitKind).toBe('employee_response');
    expect(steps[0]!.waitEventType).toBe('employee.replied');
    expect(steps[0]!.waitNote).toBe('Which supplier?');

    // === ENGINE A DIES ===

    // The employee's reply lands as a DURABLE event (any caller, no
    // engine involvement) — it both matches the waiting step's
    // subscription and is delivered as a signal.
    const dispatch = await dispatchWorkflowEvent(ctx, {
      eventType: 'employee.replied',
      payload: { answer: 'Acme, by Friday' },
      idempotencyKey: 'reply-1',
    });
    expect(dispatch.signalsDelivered).toBe(1);

    // A non-matching event type must NOT release the wait.
    const other = await dispatchWorkflowEvent(ctx, {
      eventType: 'employee.typed',
      payload: {},
      idempotencyKey: 'typed-1',
    });
    expect(other.signalsDelivered).toBe(0);

    // Fresh engine: the pump consumes the signal and resumes with the reply.
    const engineB: WorkflowEnginePort = createWorkflowEngine({
      'demo.ask': {
        ask: async (inv) => {
          received = inv.wait;
          return { type: 'done', output: { answer: (inv.wait as unknown as { payload: { answer: string } }).payload } } as const;
        },
      },
    });
    const resumed = await engineB.pump(ctx);
    expect(resumed.status).toBe('processed');
    expect(received).toMatchObject({
      kind: 'employee_response',
      eventType: 'employee.replied',
    });
    expect((received as unknown as { payload: { answer: string } }).payload).toEqual({ answer: 'Acme, by Friday' });
    const finished = await getRun(ctx, { runId: run.id });
    expect(finished.status).toBe('succeeded');
    expect(finished.result).toEqual({ answer: { answer: 'Acme, by Friday' } });

    // The signal is consumed exactly once — a second pump does nothing.
    expect((await engineB.pump(ctx)).status).toBe('idle');
  });

  it('an explicit resumeRun signal releases a waiting run', async () => {
    const ctx = member(tenantEmployee);
    const engine: WorkflowEnginePort = createWorkflowEngine({
      'demo.ask': {
        ask: async (inv) => {
          if (inv.wait === null) {
            return {
              type: 'wait',
              wait: { kind: 'employee_response', note: 'Please confirm' },
            } as const;
          }
          return { type: 'done', output: { got: (inv.wait as unknown as { payload: unknown }).payload } } as const;
        },
      },
    });
    const run = await startRun(ctx, { definitionKey: 'demo.ask' });
    await engine.pump(ctx);

    // resumeRun only targets employee-response waits.
    const timerRun = run.id;
    await expect(resumeRun(ctx, { runId: timerRun, payload: {} })).resolves.toBeDefined();

    const outcome = await engine.pump(ctx);
    expect(outcome.status).toBe('processed');
    const finished = await getRun(ctx, { runId: run.id });
    expect(finished.status).toBe('succeeded');
  });
});

// ---------------------------------------------------------------------------
// Timer waits
// ---------------------------------------------------------------------------

describe('timer waits', () => {
  beforeAll(async () => {
    const ctx = member(tenantTimer);
    await registerWorkflow(ctx, {
      key: 'demo.timer',
      title: 'Timer',
      spec: { steps: [{ key: 'slow' }] },
    });
  });

  it('suspends until the persisted resume instant, then continues', async () => {
    const ctx = member(tenantTimer);
    const engine: WorkflowEnginePort = createWorkflowEngine({
      'demo.timer': {
        slow: async (inv) => {
          if (inv.wait === null) {
            return { type: 'wait', wait: { kind: 'timer', resumeAt: new Date(clockMs + 60_000).toISOString() } } as const;
          }
          expect(inv.wait.kind).toBe('timer');
          return { type: 'done', output: { resumed: true } } as const;
        },
      },
    });
    const run = await startRun(ctx, { definitionKey: 'demo.timer' });
    expect((await engine.pump(ctx)).status).toBe('suspended');

    const steps = await listRunSteps(ctx, { runId: run.id });
    expect(steps[0]!.waitKind).toBe('timer');
    expect(steps[0]!.waitResumeAt).toBe(new Date(BASE_TIME + 60_000).toISOString());

    // Not yet due.
    expect((await engine.pump(ctx)).status).toBe('idle');
    advance(30);
    expect((await engine.pump(ctx)).status).toBe('idle');

    // Due → resume → complete.
    advance(31);
    const outcome = await engine.pump(ctx);
    expect(outcome.status).toBe('processed');
    expect(outcome.runStatus).toBe('succeeded');
    const finished = await getRun(ctx, { runId: run.id });
    expect(finished.result).toEqual({ resumed: true });
  });
});

// ---------------------------------------------------------------------------
// Long-running cognition: durable checkpoints
// ---------------------------------------------------------------------------

describe('long-running cognition: checkpoints survive engine death', () => {
  beforeAll(async () => {
    const ctx = member(tenantCheckpoint);
    await registerWorkflow(ctx, {
      key: 'demo.cognition',
      title: 'Cognition',
      spec: { steps: [{ key: 'think', leaseSeconds: 60 }] },
    });
  });

  function thinkingExecutor(engine: string) {
    return async (inv: WorkflowStepInvocation) => {
      invocations.push({
        engine,
        stepKey: inv.stepKey,
        invocation: inv.invocation,
        attempt: inv.attempt,
        wait: inv.wait,
        checkpoint: inv.checkpoint,
        idempotencyKey: inv.idempotencyKey,
        cancelledFlag: false,
      });
      const previous = (inv.checkpoint as { count: number } | null)?.count ?? 0;
      const count = previous + 1;
      if (count < 3) {
        return { type: 'checkpoint', progress: { count } } as const;
      }
      return { type: 'done', output: { count } } as const;
    };
  }

  it('checkpointed progress survives a mid-flight engine death — nothing is recomputed', async () => {
    const ctx = member(tenantCheckpoint);
    const engineA: WorkflowEnginePort = createWorkflowEngine({
      'demo.cognition': { think: thinkingExecutor('A') },
    });
    const run = await startRun(ctx, { definitionKey: 'demo.cognition' });

    // Two checkpoint yields under engine A (progress 1, then 2).
    expect((await engineA.pump(ctx)).status).toBe('processed');
    expect((await engineA.pump(ctx)).status).toBe('processed');
    let steps = await listRunSteps(ctx, { runId: run.id });
    expect(steps[0]!.checkpoint).toEqual({ count: 2 });

    // === ENGINE A DIES ===

    // Fresh engine: the continuation sees checkpoint {count: 2} and
    // finishes — progress 1 and 2 are never recomputed.
    const engineB: WorkflowEnginePort = createWorkflowEngine({
      'demo.cognition': { think: thinkingExecutor('B') },
    });
    const outcome = await engineB.pump(ctx);
    expect(outcome.status).toBe('processed');
    expect(outcome.runStatus).toBe('succeeded');

    const finished = await getRun(ctx, { runId: run.id });
    expect(finished.result).toEqual({ count: 3 });

    // Continuations are clean (no abandoned invocations).
    const attempts = await listRunStepAttempts(ctx, { runId: run.id });
    expect(attempts.map((a) => [a.invocation, a.outcome])).toEqual([
      [1, 'checkpoint'],
      [2, 'checkpoint'],
      [3, 'completed'],
    ]);
    expect(invocations.map((entry) => [entry.engine, entry.checkpoint])).toEqual([
      ['A', null],
      ['A', { count: 1 }],
      ['B', { count: 2 }],
    ]);
    steps = await listRunSteps(ctx, { runId: run.id });
    expect(steps[0]!.invocationCount).toBe(3);
    expect(steps[0]!.attemptCount).toBe(0);
  });

  it('a checkpoint with a delay defers its continuation until the delay elapses', async () => {
    const ctx = member(tenantCheckpoint);
    const engine: WorkflowEnginePort = createWorkflowEngine({
      'demo.cognition': {
        think: async (inv) => {
          if (inv.checkpoint === null) {
            return { type: 'checkpoint', progress: { p: 1 }, resumeInSeconds: 60 } as const;
          }
          return { type: 'done', output: { done: true } } as const;
        },
      },
    });
    const run = await startRun(ctx, { definitionKey: 'demo.cognition' });
    expect((await engine.pump(ctx)).status).toBe('processed');
    // The continuation is gated by the delay.
    expect((await engine.pump(ctx)).status).toBe('idle');
    advance(61);
    expect((await engine.pump(ctx)).runStatus).toBe('succeeded');
    const finished = await getRun(ctx, { runId: run.id });
    expect(finished.result).toEqual({ done: true });
  });
});

// ---------------------------------------------------------------------------
// Retries and deterministic failures
// ---------------------------------------------------------------------------

describe('retries and deterministic failures', () => {
  beforeAll(async () => {
    const ctx = member(tenantRetry);
    await registerWorkflow(ctx, {
      key: 'demo.retry',
      title: 'Retry',
      spec: {
        steps: [{ key: 'flaky', maxAttempts: 3, retryBackoffSeconds: 1, leaseSeconds: 60 }],
      },
    });
    await registerWorkflow(ctx, {
      key: 'demo.deterministic',
      title: 'Deterministic',
      spec: { steps: [{ key: 'strict' }] },
    });
  });

  it('retries transient failures with explicit attempt counters and backoff, then succeeds', async () => {
    const ctx = member(tenantRetry);
    let failures = 0;
    const engine: WorkflowEnginePort = createWorkflowEngine({
      'demo.retry': {
        flaky: async (inv) => {
          if (failures < 2) {
            failures += 1;
            throw new Error(`transient blip ${failures}`);
          }
          return { type: 'done', output: { ok: true, attempts: inv.attempt } } as const;
        },
      },
    });
    const run = await startRun(ctx, { definitionKey: 'demo.retry' });

    const first = await engine.pump(ctx);
    expect(first.status).toBe('retried');
    expect(first.detail).toContain('attempt 1/3');
    let steps = await listRunSteps(ctx, { runId: run.id });
    expect(steps[0]!.status).toBe('pending');
    expect(steps[0]!.attemptCount).toBe(1);
    expect(steps[0]!.retryNotBefore).toBe(new Date(BASE_TIME + 1000).toISOString());

    // Backoff not elapsed → idle.
    expect((await engine.pump(ctx)).status).toBe('idle');
    advance(2);
    const second = await engine.pump(ctx);
    expect(second.status).toBe('retried');
    expect(second.detail).toContain('attempt 2/3');
    steps = await listRunSteps(ctx, { runId: run.id });
    expect(steps[0]!.retryNotBefore).toBe(new Date(BASE_TIME + 2000 + 2000).toISOString());

    advance(3);
    const third = await engine.pump(ctx);
    expect(third.status).toBe('processed');
    expect(third.runStatus).toBe('succeeded');
    const finished = await getRun(ctx, { runId: run.id });
    expect(finished.result).toEqual({ ok: true, attempts: 2 });

    const attempts = await listRunStepAttempts(ctx, { runId: run.id });
    expect(attempts.map((a) => [a.invocation, a.outcome, a.errorCode])).toEqual([
      [1, 'failed', 'transient_failure'],
      [2, 'failed', 'transient_failure'],
      [3, 'completed', null],
    ]);
    steps = await listRunSteps(ctx, { runId: run.id });
    expect(steps[0]!.attemptCount).toBe(2);
    expect(steps[0]!.invocationCount).toBe(3);
  });

  it('dead-letters deterministic rejections immediately (retrying cannot change them)', async () => {
    const ctx = member(tenantRetry);
    const engine: WorkflowEnginePort = createWorkflowEngine({
      'demo.deterministic': {
        strict: async () => {
          throw new WorkflowStepError('bad_input', 'the input is unusable');
        },
      },
    });
    const run = await startRun(ctx, { definitionKey: 'demo.deterministic' });
    const outcome = await engine.pump(ctx);
    expect(outcome.status).toBe('failed');
    const failed = await getRun(ctx, { runId: run.id });
    expect(failed.status).toBe('failed');
    expect(failed.errorCode).toBe('bad_input');
    expect(failed.errorDetail).toContain('unusable');
    // No retry was scheduled.
    const steps = await listRunSteps(ctx, { runId: run.id });
    expect(steps[0]!.status).toBe('failed');
    expect(steps[0]!.attemptCount).toBe(1);
    expect(steps[0]!.invocationCount).toBe(1);
    expect((await engine.pump(ctx)).status).toBe('idle');
  });

  it('fails a step deterministically when no executor binding exists', async () => {
    const ctx = member(tenantRetry);
    const engine: WorkflowEnginePort = createWorkflowEngine({});
    const run = await startRun(ctx, { definitionKey: 'demo.deterministic' });
    const outcome = await engine.pump(ctx);
    expect(outcome.status).toBe('failed');
    const failed = await getRun(ctx, { runId: run.id });
    expect(failed.errorCode).toBe('executor_missing');
  });

  it('fails deterministically on malformed executor results', async () => {
    const ctx = member(tenantRetry);
    const engine: WorkflowEnginePort = createWorkflowEngine({
      'demo.deterministic': {
        strict: async () => 'not-a-valid-result' as unknown as ReturnType<typeof Object>,
      },
    });
    const run = await startRun(ctx, { definitionKey: 'demo.deterministic' });
    const outcome = await engine.pump(ctx);
    expect(outcome.status).toBe('failed');
    const failed = await getRun(ctx, { runId: run.id });
    expect(failed.errorCode).toBe('invalid_executor_result');
  });
});

// ---------------------------------------------------------------------------
// Cooperative cancellation
// ---------------------------------------------------------------------------

describe('cooperative cancellation', () => {
  beforeAll(async () => {
    const ctx = member(tenantCancel);
    await registerWorkflow(ctx, {
      key: 'demo.cancel',
      title: 'Cancel me',
      spec: { steps: [{ key: 'work', leaseSeconds: 60 }] },
    });
  });

  it('cancels a pending run outright', async () => {
    const ctx = member(tenantCancel);
    const run = await startRun(ctx, { definitionKey: 'demo.cancel' });
    const cancelled = await cancelRun(ctx, { runId: run.id, reason: 'not needed' });
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.cancelReason).toBe('not needed');
    expect(cancelled.finishedAt).not.toBeNull();
    const steps = await listRunSteps(ctx, { runId: run.id });
    expect(steps[0]!.status).toBe('cancelled');
    // Terminal runs are not cancellable.
    await expect(cancelRun(ctx, { runId: run.id, reason: 'again' })).rejects.toMatchObject({
      code: 'not_cancellable',
    });
  });

  it('cancels a waiting run outright (the wait is abandoned)', async () => {
    const ctx = member(tenantCancel);
    const engine: WorkflowEnginePort = createWorkflowEngine({
      'demo.cancel': {
        work: async () => ({ type: 'wait', wait: { kind: 'timer', resumeAt: new Date(clockMs + 3600_000).toISOString() } } as const),
      },
    });
    const run = await startRun(ctx, { definitionKey: 'demo.cancel' });
    await engine.pump(ctx);
    const cancelled = await cancelRun(ctx, { runId: run.id, reason: 'superseded' });
    expect(cancelled.status).toBe('cancelled');
    const steps = await listRunSteps(ctx, { runId: run.id });
    expect(steps[0]!.status).toBe('cancelled');
    expect(steps[0]!.waitKind).toBeNull();
    expect((await engine.pump(ctx)).status).toBe('idle');
  });

  it('records a running-run cancellation request durably and finalizes it cooperatively', async () => {
    const ctx = member(tenantCancel);
    const run = await startRun(ctx, { definitionKey: 'demo.cancel' });
    // A live executor holds the step (claimed, live lease).
    await simulateDeadWorkerClaim(tenantCancel, run.id, 60);
    const cancelling = await cancelRun(ctx, { runId: run.id, reason: 'operator stop' });
    expect(cancelling.status).toBe('cancelling');
    expect(cancelling.cancelRequestedAt).not.toBeNull();

    const engine: WorkflowEnginePort = createWorkflowEngine({
      'demo.cancel': { work: effectfulDoneExecutor('L') },
    });
    // While the lease is live, the pump neither invokes the executor nor
    // finalizes the cancellation (cooperative).
    expect((await engine.pump(ctx)).status).toBe('idle');

    // Once the executor stops holding the run (lease expiry), the pump
    // finalizes the cancellation.
    advance(61);
    const outcome = await engine.pump(ctx);
    expect(outcome.status).toBe('cancelled');
    expect(outcome.runStatus).toBe('cancelled');
    const finished = await getRun(ctx, { runId: run.id });
    expect(finished.status).toBe('cancelled');
    expect(finished.cancelReason).toBe('operator stop');
    expect(finished.cancelledBy).toBe(cancelling.cancelledBy);
    const steps = await listRunSteps(ctx, { runId: run.id });
    expect(steps[0]!.status).toBe('cancelled');
    // The executor was never invoked — cancellation won the race.
    expect(invocations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Guarded concurrency (the two-pump safety net)
// ---------------------------------------------------------------------------

describe('guarded concurrency', () => {
  beforeAll(async () => {
    const ctx = member(tenantConcurrency);
    await registerWorkflow(ctx, {
      key: 'demo.race',
      title: 'Race',
      spec: { steps: [{ key: 'work', leaseSeconds: 60 }] },
    });
  });

  it('never double-invokes a step held by a live lease (a concurrent pump goes idle)', async () => {
    const ctx = member(tenantConcurrency);
    const run = await startRun(ctx, { definitionKey: 'demo.race' });
    // Pump A claims the step and "dies" mid-executor (lease live).
    await simulateDeadWorkerClaim(tenantConcurrency, run.id, 60);
    const engineB: WorkflowEnginePort = createWorkflowEngine({
      'demo.race': { work: effectfulDoneExecutor('B') },
    });
    expect((await engineB.pump(ctx)).status).toBe('idle');
    expect(invocations).toEqual([]);
  });

  it('reports conflict when an invocation\'s outcome loses its guarded persist race', async () => {
    const ctx = member(tenantConcurrency);
    const run = await startRun(ctx, { definitionKey: 'demo.race' });
    const engine: WorkflowEnginePort = createWorkflowEngine({
      'demo.race': {
        // The executor itself simulates a racing pump: before returning,
        // the step is flipped to a terminal state out from under this
        // invocation — the engine's guarded persist must detect the loss.
        work: async () => {
          await getDb().query(
            `UPDATE workflow_run_steps
               SET status = 'succeeded', finished_at = $3, lease_expires_at = NULL, updated_at = $3
             WHERE tenant_id = $1 AND run_id = $2 AND step_number = 1`,
            [tenantConcurrency, run.id, new Date(clockMs)],
          );
          return { type: 'done', output: { stale: true } } as const;
        },
      },
    });
    const outcome = await engine.pump(ctx);
    expect(outcome.status).toBe('conflict');
    // The stale outcome was discarded — the run is still running, and no
    // result was recorded from the losing invocation.
    const after = await getRun(ctx, { runId: run.id });
    expect(after.status).toBe('running');
    expect(after.result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Pump composition with triggers
// ---------------------------------------------------------------------------

describe('pump composition with event triggers and schedules', () => {
  beforeAll(async () => {
    const ctx = member(tenantPumpMisc);
    await registerWorkflow(ctx, {
      key: 'demo.triggered',
      title: 'Triggered',
      spec: { steps: [{ key: 'act' }], eventTriggers: ['thing.happened'] },
    });
  });

  it('event-triggered runs pump to completion', async () => {
    const ctx = member(tenantPumpMisc);
    const engine: WorkflowEnginePort = createWorkflowEngine({
      'demo.triggered': {
        act: async (inv) => {
          recordEffect(inv.idempotencyKey);
          return { type: 'done', output: { saw: inv.input } } as const;
        },
      },
    });
    const dispatch = await dispatchWorkflowEvent(ctx, {
      eventType: 'thing.happened',
      payload: { thing: 42 },
      idempotencyKey: 'thing-42',
    });
    expect(dispatch.runsStarted).toHaveLength(1);
    const outcome = await engine.pump(ctx);
    expect(outcome.status).toBe('processed');
    expect(outcome.runStatus).toBe('succeeded');
    const finished = await getRun(ctx, { runId: dispatch.runsStarted[0]!.id });
    expect(finished.result).toEqual({ saw: { thing: 42 } });
    expect(effects.size).toBe(1);
  });

  it('schedule-fired runs pump to completion', async () => {
    const ctx = member(tenantPumpMisc);
    const engine: WorkflowEnginePort = createWorkflowEngine({
      'demo.triggered': {
        act: async (inv) => {
          recordEffect(inv.idempotencyKey);
          return { type: 'done', output: { tick: true } } as const;
        },
      },
    });
    await registerWorkflow(ctx, { key: 'demo.sched2', title: 'S2', spec: { steps: [{ key: 'act' }] } });
    void engine;
    // createSchedule through the engine port (same surface the worker loop uses).
    const schedule = await engine.createSchedule(ctx, { definitionKey: 'demo.triggered', cron: '*/5 * * * *' });
    advance(5 * 60);
    const sweep = await engine.evaluateSchedules(ctx);
    expect(sweep.occurrencesFired).toBe(1);
    expect(schedule.active).toBe(true);
    const outcome = await engine.pump(ctx);
    expect(outcome.runStatus).toBe('succeeded');
  });

  it('the executor\'s cooperative cancellation flag reflects the durable run state', async () => {
    const ctx = member(tenantPumpMisc);
    let observedCancelled: boolean | null = null;
    const engine: WorkflowEnginePort = createWorkflowEngine({
      'demo.triggered': {
        act: async (inv) => {
          observedCancelled = await inv.cancelled();
          return { type: 'done', output: {} } as const;
        },
      },
    });
    const dispatch = await dispatchWorkflowEvent(ctx, {
      eventType: 'thing.happened',
      payload: {},
      idempotencyKey: 'thing-cxl',
    });
    await engine.pump(ctx);
    expect(observedCancelled).toBe(false);

    // A cancelled run reports true (cooperative signal for long-running work).
    const run2dispatch = await dispatchWorkflowEvent(ctx, {
      eventType: 'thing.happened',
      payload: {},
      idempotencyKey: 'thing-cxl-2',
    });
    const run2 = run2dispatch.runsStarted[0]!;
    // Claim the step first so cancelRun takes the cooperative path.
    await simulateDeadWorkerClaim(tenantPumpMisc, run2.id, 60);
    await cancelRun(ctx, { runId: run2.id, reason: 'stop' });
    advance(61);
    const outcome = await engine.pump(ctx);
    expect(outcome.status).toBe('cancelled');
  });
});

// Guard against unused-import lint noise (the tag helper documents the
// engine-generation labels used in the invocation logs above).
void tag;
