// W044 — Tenant Isolation Verification · application- and repository-
// boundary sweep for the workflow module (W080 — Durable Agent Runtime
// Adapter).
//
// The workflow module is information-bearing domain state (definitions,
// runs, steps, attempt evidence, events, signals, schedules, firings —
// all tenant-scoped), so this is a REAL two-tenant contract sweep, the
// capability-sweep doctrine:
//   * definitions share keys per tenant — registering the same key in
//     tenant B never disturbs tenant A's versions;
//   * runs (and their steps, attempts and result) are invisible across
//     tenants with the uniform not-found code — no existence leak —
//     including through the trace surfaces and the idempotency keys
//     (same key, two tenants, two distinct runs);
//   * THE PUMP IS TENANT-SCOPED: pumping tenant B never advances tenant
//     A's runs, and an executor binding only ever fires for the run's
//     own tenant;
//   * event dispatch materializes runs and delivers signals only for
//     the dispatching tenant, even when both tenants subscribe to the
//     same event type;
//   * schedule evaluation fires only the evaluating tenant's schedules;
//   * authority claims never widen tenant scope (the omnipotent probe);
//   * repository boundary — every workflow table carries a NOT NULL
//     uuid tenant_id, and after the fixtures ran no row in ANY
//     tenant-scoped table escaped the sweep's two tenants.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import {
  cancelRun,
  createSchedule,
  createWorkflowEngine,
  dispatchWorkflowEvent,
  evaluateSchedules,
  getRun,
  getWorkflowDefinition,
  getWorkflowEvent,
  listRunStepAttempts,
  listRunSteps,
  listRuns,
  listSchedules,
  registerWorkflow,
  resumeRun,
  setScheduleActive,
  startRun,
  type WorkflowEnginePort,
  type WorkflowStepInvocation,
} from '@/modules/workflow/contract';
import {
  assertTenantPartition,
  expectUniformNotFound,
  member,
  omnipotent,
  runMigrations,
  tableColumns,
} from './harness';

const tenantA = newId();
const tenantB = newId();
const ctxA = member(tenantA);
const ctxB = member(tenantB);

const SPEC = {
  steps: [{ key: 'only', maxAttempts: 2, retryBackoffSeconds: 1, leaseSeconds: 60 }],
  eventTriggers: ['shared.event'],
};

/** Executor invocations observed, tagged with the invocation's tenant. */
const observed: { tenantId: string; runId: string }[] = [];

function engine(): WorkflowEnginePort {
  return createWorkflowEngine({
    'demo.isolation': {
      only: async (inv: WorkflowStepInvocation) => {
        observed.push({ tenantId: inv.tenantId, runId: inv.runId });
        return { type: 'done', output: { by: inv.tenantId } };
      },
    },
  });
}

const WORKFLOW_TABLES = [
  'workflow_definitions',
  'workflow_definition_versions',
  'workflow_events',
  'workflow_runs',
  'workflow_run_steps',
  'workflow_step_attempts',
  'workflow_run_signals',
  'workflow_schedules',
  'workflow_schedule_firings',
];

beforeAll(async () => {
  await runMigrations(getDb());
  // Both tenants register the SAME definition key — per-tenant namespaces.
  await registerWorkflow(ctxA, { key: 'demo.isolation', title: 'Iso A', spec: SPEC });
  await registerWorkflow(ctxB, { key: 'demo.isolation', title: 'Iso B', spec: SPEC });
});

afterAll(async () => {
  const { closeDb } = await import('@/infra/db');
  await closeDb();
});

describe('W044 sweep — workflow (W080 durable runtime)', () => {
  it('scopes definitions per tenant (same key, independent content)', async () => {
    const defA = await getWorkflowDefinition(ctxA, { key: 'demo.isolation' });
    const defB = await getWorkflowDefinition(ctxB, { key: 'demo.isolation' });
    expect(defA.id).not.toBe(defB.id);
    expect(defA.title).toBe('Iso A');
    expect(defB.title).toBe('Iso B');
    await expectUniformNotFound(
      'definition_not_found',
      () => getWorkflowDefinition(member(newId()), { key: 'demo.isolation' }),
      () => getWorkflowDefinition(ctxA, { key: 'missing.key' }),
    );
    // Retiring in tenant B leaves tenant A active.
    await getDb().query(
      `UPDATE workflow_definitions SET status = 'retired' WHERE tenant_id = $1 AND key = 'demo.isolation'`,
      [tenantB],
    );
    expect((await getWorkflowDefinition(ctxA, { key: 'demo.isolation' })).status).toBe('active');
    await expect(startRun(ctxB, { definitionKey: 'demo.isolation' })).rejects.toMatchObject({
      code: 'definition_not_active',
    });
    await getDb().query(
      `UPDATE workflow_definitions SET status = 'active' WHERE tenant_id = $1 AND key = 'demo.isolation'`,
      [tenantB],
    );
  });

  it('isolates runs, traces and idempotency keys across tenants', async () => {
    const runA = await startRun(ctxA, { definitionKey: 'demo.isolation', idempotencyKey: 'shared-key' });
    const runB = await startRun(ctxB, { definitionKey: 'demo.isolation', idempotencyKey: 'shared-key' });
    expect(runA.id).not.toBe(runB.id);
    expect(runA.tenantId).toBe(tenantA);
    expect(runB.tenantId).toBe(tenantB);

    // Cross-tenant reads are uniformly not-found — no existence leak.
    await expectUniformNotFound(
      'run_not_found',
      () => getRun(ctxB, { runId: runA.id }),
      () => getRun(ctxA, { runId: newId() }),
    );
    await expectUniformNotFound(
      'run_not_found',
      () => listRunSteps(ctxB, { runId: runA.id }),
      () => listRunSteps(ctxA, { runId: newId() }),
    );
    await expectUniformNotFound(
      'run_not_found',
      () => listRunStepAttempts(ctxB, { runId: runA.id }),
      () => listRunStepAttempts(ctxA, { runId: newId() }),
    );

    // Cross-tenant writes cannot touch the foreign run.
    await expectUniformNotFound(
      'run_not_found',
      () => cancelRun(ctxB, { runId: runA.id, reason: 'nope' }),
      () => cancelRun(ctxA, { runId: newId(), reason: 'nope' }),
    );
    await expect(resumeRun(ctxB, { runId: runA.id, payload: {} })).rejects.toMatchObject({
      code: 'run_not_found',
    });

    // Lists stay per-tenant.
    expect((await listRuns(ctxA, { definitionKey: 'demo.isolation' })).map((r) => r.id)).toEqual([runA.id]);
    expect((await listRuns(ctxB, { definitionKey: 'demo.isolation' })).map((r) => r.id)).toEqual([runB.id]);
  });

  it('keeps the pump tenant-scoped (pumping B never advances A)', async () => {
    observed.length = 0;
    const runA = await startRun(ctxA, { definitionKey: 'demo.isolation' });
    const runB = await startRun(ctxB, { definitionKey: 'demo.isolation' });
    const pump = engine();

    // Drain tenant B's pumpable work (earlier tests left pending runs) —
    // EVERY advanced run must belong to tenant B, and tenant A's run must
    // stay untouched throughout.
    let runBCompleted = false;
    for (let i = 0; i < 20 && !runBCompleted; i += 1) {
      const outcome = await pump.pump(ctxB);
      if (outcome.status === 'idle') break;
      expect(outcome.runId).not.toBe(runA.id);
      if (outcome.runId === runB.id && outcome.runStatus === 'succeeded') runBCompleted = true;
    }
    expect(runBCompleted, 'tenant B\'s pump must complete tenant B\'s run').toBe(true);
    expect(observed.length).toBeGreaterThan(0);
    expect(observed.every((entry) => entry.tenantId === tenantB)).toBe(true);
    expect(observed.some((entry) => entry.runId === runB.id)).toBe(true);

    // Tenant A's run is untouched by all of B's pumping.
    expect((await getRun(ctxA, { runId: runA.id })).status).toBe('pending');

    // Pumping tenant A completes A's run only.
    let runACompleted = false;
    for (let i = 0; i < 20 && !runACompleted; i += 1) {
      const outcome = await pump.pump(ctxA);
      if (outcome.status === 'idle') break;
      expect(observed.some((entry) => entry.runId === outcome.runId && entry.tenantId === tenantA)).toBe(true);
      if (outcome.runId === runA.id && outcome.runStatus === 'succeeded') runACompleted = true;
    }
    expect(runACompleted, 'tenant A\'s pump must complete tenant A\'s run').toBe(true);

    // The results never crossed.
    expect((await getRun(ctxA, { runId: runA.id })).result).toEqual({ by: tenantA });
    expect((await getRun(ctxB, { runId: runB.id })).result).toEqual({ by: tenantB });
  });

  it('materializes event triggers only for the dispatching tenant', async () => {
    // Both tenants subscribe to the same event type.
    const dispatchA = await dispatchWorkflowEvent(ctxA, {
      eventType: 'shared.event',
      payload: { who: 'A' },
      idempotencyKey: 'evt-A',
    });
    expect(dispatchA.runsStarted).toHaveLength(1);
    expect(dispatchA.runsStarted[0]!.tenantId).toBe(tenantA);
    expect(dispatchA.runsStarted[0]!.input).toEqual({ who: 'A' });

    // Tenant B dispatches the same type with its own key — only B's runs.
    const dispatchB = await dispatchWorkflowEvent(ctxB, {
      eventType: 'shared.event',
      payload: { who: 'B' },
      idempotencyKey: 'evt-B',
    });
    expect(dispatchB.runsStarted).toHaveLength(1);
    expect(dispatchB.runsStarted[0]!.tenantId).toBe(tenantB);

    // Idempotent replay per tenant (keys are tenant-scoped).
    const replayA = await dispatchWorkflowEvent(ctxA, {
      eventType: 'shared.event',
      payload: {},
      idempotencyKey: 'evt-A',
    });
    expect(replayA.replayed).toBe(true);
    expect(replayA.runsStarted).toEqual([]);

    // Cross-tenant event reads are uniformly not-found.
    await expectUniformNotFound(
      'event_not_found',
      () => getWorkflowEvent(ctxB, { eventId: dispatchA.event.id }),
      () => getWorkflowEvent(ctxA, { eventId: newId() }),
    );

    // Each tenant's event-triggered run list is its own.
    expect((await listRuns(ctxA, { trigger: 'event' })).length).toBe(1);
    expect((await listRuns(ctxB, { trigger: 'event' })).length).toBe(1);
  });

  it('evaluates schedules only for the evaluating tenant', async () => {
    await createSchedule(ctxA, { definitionKey: 'demo.isolation', cron: '*/5 * * * *', input: { t: 'A' } });
    const scheduleB = await createSchedule(ctxB, { definitionKey: 'demo.isolation', cron: '*/5 * * * *', input: { t: 'B' } });

    // Age both tenants' schedules past one cron boundary (fixture
    // manipulation at the repository boundary — the sweep owns its data).
    await getDb().query(
      `UPDATE workflow_schedules SET created_at = created_at - interval '10 minutes' WHERE tenant_id = $1`,
      [tenantA],
    );
    await getDb().query(
      `UPDATE workflow_schedules SET created_at = created_at - interval '10 minutes' WHERE tenant_id = $1`,
      [tenantB],
    );

    const sweepA = await evaluateSchedules(ctxA);
    expect(sweepA.occurrencesFired).toBeGreaterThanOrEqual(1);
    expect(sweepA.runsStarted.every((run) => run.tenantId === tenantA)).toBe(true);
    const runsA = (await listRuns(ctxA, { trigger: 'schedule' })).length;
    expect(runsA).toBe(sweepA.runsStarted.length);

    // Tenant B's schedule is untouched by A's sweep.
    const storedB = (await listSchedules(ctxB, {})).find((s) => s.id === scheduleB.id)!;
    expect(storedB.lastOccurrenceAt).toBeNull();

    const sweepB = await evaluateSchedules(ctxB);
    expect(sweepB.runsStarted.every((run) => run.tenantId === tenantB)).toBe(true);
    expect((await listRuns(ctxB, { trigger: 'schedule' })).length).toBe(sweepB.runsStarted.length);

    // Cross-tenant schedule operations are uniformly not-found.
    const scheduleA = (await listSchedules(ctxA, {}))[0]!;
    await expectUniformNotFound(
      'schedule_not_found',
      () => setScheduleActive(ctxB, { scheduleId: scheduleA.id, active: false }),
      () => setScheduleActive(ctxA, { scheduleId: newId(), active: false }),
    );
  });

  it('authority claims never widen tenant scope (the omnipotent probe)', async () => {
    const godB = omnipotent(tenantB);
    const runA = (await listRuns(ctxA, { definitionKey: 'demo.isolation' }))[0]!;
    await expect(getRun(godB, { runId: runA.id })).rejects.toMatchObject({ code: 'run_not_found' });
    await expect(
      listRunSteps(godB, { runId: runA.id }),
    ).rejects.toMatchObject({ code: 'run_not_found' });
    await expect(
      cancelRun(godB, { runId: runA.id, reason: 'god' }),
    ).rejects.toMatchObject({ code: 'run_not_found' });
    // The omnipotent principal of tenant B sees exactly what a plain
    // member of tenant B sees — never a row of tenant A.
    const godRuns = await listRuns(godB, {});
    const plainRuns = await listRuns(ctxB, {});
    expect(godRuns.map((run) => run.id).sort()).toEqual(plainRuns.map((run) => run.id).sort());
    expect(godRuns.every((run) => run.tenantId === tenantB)).toBe(true);
    // Pumping as the omnipotent principal of B advances only tenant B's
    // runs — tenant A's statuses never move.
    const before = (await listRuns(ctxA, {})).map((run) => [run.id, run.status]);
    const tenantBRunIds = new Set(plainRuns.map((run) => run.id));
    for (let i = 0; i < 20; i += 1) {
      const outcome = await engine().pump(godB);
      if (outcome.status === 'idle') break;
      expect(outcome.runId === null || tenantBRunIds.has(outcome.runId)).toBe(true);
    }
    const after = (await listRuns(ctxA, {})).map((run) => [run.id, run.status]);
    expect(after).toEqual(before);
  });

  it('carries a NOT NULL uuid tenant_id on every workflow table (repository boundary)', async () => {
    const columns = await tableColumns();
    for (const table of WORKFLOW_TABLES) {
      const tenantColumn = columns.find(
        (column) => column.table_name === table && column.column_name === 'tenant_id',
      );
      expect(tenantColumn, `${table} must carry a tenant_id column`).toBeDefined();
      expect(tenantColumn!.data_type, `${table}.tenant_id must be uuid`).toBe('uuid');
      expect(tenantColumn!.is_nullable, `${table}.tenant_id must be NOT NULL`).toBe('NO');
    }
  });

  it('holds the row partition across every tenant-scoped table after the fixtures ran', async () => {
    await assertTenantPartition([tenantA, tenantB]);
  });
});
