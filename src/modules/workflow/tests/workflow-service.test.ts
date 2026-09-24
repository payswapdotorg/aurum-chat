// Integration tests for the workflow module's data operations (W080)
// against the embedded PostgreSQL (PGlite, `:memory:`) through the db
// port — the service surface beneath the engine: definition
// registration/versioning, run creation and idempotency, event
// dispatch materialization, schedules, queries, tenant isolation and
// the storage-level guarantees (guard triggers, dedupe constraints).
//
// The ENGINE's pump semantics (resumption, waits, retries, cancellation
// — the W080 acceptance core) live in workflow-resumption.test.ts.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { systemClock } from '@/infra/clock';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { appendEvent } from '@/modules/events/contract';

import * as workflowContract from '../contract';
import { WorkflowError } from '../errors';
import { runMigrations } from '../../../../scripts/migrate';

const {
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
  listWorkflowDefinitions,
  registerWorkflow,
  resumeRun,
  setScheduleActive,
  startRun,
  cancelRun,
} = workflowContract;

// Dedicated tenants per group so count/order assertions stay deterministic.
const tenantDefs = newId();
const tenantRuns = newId();
const tenantEvents = newId();
const tenantSchedules = newId();
const tenantRetired = newId();
const tenantFire = newId();
const tenantIsoA = newId();
const tenantIsoB = newId();
const tenantStorage = newId();

const BASE_TIME = Date.parse('2026-09-24T11:57:30Z'); // Thursday
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

const SIMPLE_SPEC = {
  steps: [
    { key: 'only', maxAttempts: 2, retryBackoffSeconds: 1, leaseSeconds: 60 },
  ],
};

beforeAll(async () => {
  await runMigrations(getDb());
});

afterAll(async () => {
  await closeDb();
});

beforeEach(() => {
  setClock(BASE_TIME);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Contract surface
// ---------------------------------------------------------------------------

describe('contract surface (the module exposes exactly its public operations)', () => {
  it('pins the export set', () => {
    expect(Object.keys(workflowContract).sort()).toEqual([
      'ATTEMPT_OUTCOMES',
      'CANCELLABLE_RUN_STATUSES',
      'CRON_HORIZON_YEARS',
      'DEFAULT_LEASE_SECONDS',
      'DEFAULT_LIST_LIMIT',
      'DEFAULT_MAX_ATTEMPTS',
      'DEFAULT_RETRY_BACKOFF_SECONDS',
      'MAX_DESCRIPTION_LENGTH',
      'MAX_EVENT_TRIGGERS',
      'MAX_EVENT_TYPE_LENGTH',
      'MAX_IDEM_KEY_LENGTH',
      'MAX_LEASE_SECONDS',
      'MAX_LIST_LIMIT',
      'MAX_MAX_ATTEMPTS',
      'MAX_NOTE_LENGTH',
      'MAX_PAYLOAD_BYTES',
      'MAX_REASON_LENGTH',
      'MAX_RETRY_BACKOFF_SECONDS',
      'MAX_SCHEDULE_OCCURRENCES_PER_SWEEP',
      'MAX_STEPS',
      'MAX_STEP_KEY_LENGTH',
      'MAX_STEP_RETRY_BACKOFF_SECONDS',
      'MAX_TITLE_LENGTH',
      'MIN_LEASE_SECONDS',
      'RUN_STATUSES',
      'RUN_TERMINAL_STATUSES',
      'STEP_STATUSES',
      'TRIGGER_KINDS',
      'WAIT_KINDS',
      'WorkflowError',
      'WorkflowStepError',
      'approvalIdempotencyKey',
      'cancelRun',
      'claimableStepPredicate',
      'createSchedule',
      'createWorkflowEngine',
      'cronMatches',
      'cronOccurrencesBetween',
      'dispatchWorkflowEvent',
      'evaluateSchedules',
      'eventRunIdempotencyKey',
      'getRun',
      'getWorkflowDefinition',
      'getWorkflowEvent',
      'isAttemptOutcome',
      'isDeterministicStepFailure',
      'isRunStatus',
      'isRunTerminal',
      'isStepStatus',
      'isTriggerKind',
      'isUuid',
      'isValidCron',
      'isWaitKind',
      'listRunStepAttempts',
      'listRunSteps',
      'listRuns',
      'listSchedules',
      'listWorkflowDefinitions',
      'nextCronOccurrence',
      'parseCron',
      'registerWorkflow',
      'resumeRun',
      'retryBackoffSeconds',
      'runStatusAfterCancelRequest',
      'scheduleRunIdempotencyKey',
      'setScheduleActive',
      'startRun',
      'stepIdempotencyKey',
      'stepStatusAfterRunCancelled',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

describe('definitions: registration and versioning', () => {
  it('registers v1 and appends the next version on content change', async () => {
    const ctx = member(tenantDefs);
    const v1 = await registerWorkflow(ctx, {
      key: 'demo.pipeline',
      title: 'Pipeline',
      description: null,
      spec: SIMPLE_SPEC,
    });
    expect(v1.version).toBe(1);
    expect(v1.status).toBe('active');
    expect(v1.spec.steps).toHaveLength(1);
    expect(v1.spec.steps[0]!.key).toBe('only');

    // Identical content → same version (no-op).
    const again = await registerWorkflow(ctx, {
      key: 'demo.pipeline',
      title: 'Pipeline',
      description: null,
      spec: SIMPLE_SPEC,
    });
    expect(again.version).toBe(1);

    // Changed content → version 2.
    const v2 = await registerWorkflow(ctx, {
      key: 'demo.pipeline',
      title: 'Pipeline v2',
      spec: {
        steps: [
          { key: 'first', maxAttempts: 2, retryBackoffSeconds: 1, leaseSeconds: 60 },
          { key: 'second' },
        ],
        eventTriggers: ['invoice.registered'],
      },
    });
    expect(v2.version).toBe(2);
    expect(v2.spec.steps).toHaveLength(2);
    expect(v2.spec.eventTriggers).toEqual(['invoice.registered']);

    // Both versions remain readable on the version ledger.
    const versions = await getDb().query<{ version: number; title: string }>(
      `SELECT version, title FROM workflow_definition_versions
        WHERE tenant_id = $1 AND definition_id = $2 ORDER BY version`,
      [tenantDefs, v1.id],
    );
    expect(versions.rows.map((row) => [row.version, row.title])).toEqual([
      [1, 'Pipeline'],
      [2, 'Pipeline v2'],
    ]);
    // The current view serves version 2.
    expect((await getWorkflowDefinition(ctx, { key: 'demo.pipeline' })).version).toBe(2);
    expect((await listWorkflowDefinitions(ctx, {})).map((d) => d.key)).toContain('demo.pipeline');
    expect((await listWorkflowDefinitions(ctx, { status: 'retired' }))).toHaveLength(0);
  });

  it('rejects invalid registrations and reports missing definitions uniformly', async () => {
    const ctx = member(tenantDefs);
    await expect(
      registerWorkflow(ctx, { key: 'BAD KEY', title: 'T', spec: SIMPLE_SPEC }),
    ).rejects.toMatchObject({ code: 'invalid_definition_input' });
    await expect(getWorkflowDefinition(ctx, { key: 'missing.one' })).rejects.toMatchObject({
      code: 'definition_not_found',
    });
  });

  it('rejects runs against unknown or retired definitions', async () => {
    const ctx = member(tenantDefs);
    await expect(startRun(ctx, { definitionKey: 'missing.one' })).rejects.toMatchObject({
      code: 'definition_not_found',
    });
    await registerWorkflow(ctx, { key: 'demo.retired', title: 'R', spec: SIMPLE_SPEC });
    await getDb().query(
      `UPDATE workflow_definitions SET status = 'retired' WHERE tenant_id = $1 AND key = 'demo.retired'`,
      [tenantDefs],
    );
    await expect(startRun(ctx, { definitionKey: 'demo.retired' })).rejects.toMatchObject({
      code: 'definition_not_active',
    });
  });
});

// ---------------------------------------------------------------------------
// Runs: creation, idempotency, listing
// ---------------------------------------------------------------------------

describe('runs: creation, idempotency, listing', () => {
  beforeAll(async () => {
    const ctx = member(tenantRuns);
    await registerWorkflow(ctx, { key: 'demo.multi', title: 'Multi', spec: {
      steps: [{ key: 'a' }, { key: 'b' }, { key: 'c' }],
    } });
  });

  it('records a pending run with its full step plan and frozen version', async () => {
    const ctx = member(tenantRuns);
    const run = await startRun(ctx, {
      definitionKey: 'demo.multi',
      input: { hello: 'world' },
      idempotencyKey: 'run-once',
      triggerReference: 'conversation-1',
    });
    expect(run.status).toBe('pending');
    expect(run.currentStep).toBe(0);
    expect(run.totalSteps).toBe(3);
    expect(run.trigger).toBe('manual');
    expect(run.input).toEqual({ hello: 'world' });
    expect(run.idempotencyKey).toBe('run-once');
    expect(run.runPrincipal).toBe(ctx.principalId);
    expect(run.runAuthority).toEqual([]);
    expect(run.startedAt).toBeNull();

    const steps = await listRunSteps(ctx, { runId: run.id });
    expect(steps.map((s) => [s.stepNumber, s.stepKey, s.status])).toEqual([
      [1, 'a', 'pending'],
      [2, 'b', 'pending'],
      [3, 'c', 'pending'],
    ]);
    // The step plan carries the frozen retry/lease policy.
    expect(steps[0]!.maxAttempts).toBe(3);
    expect(steps[0]!.retryBackoffSeconds).toBe(30);
    expect(steps[0]!.leaseSeconds).toBe(3600);

    // An idempotent replay returns the SAME run (first write wins).
    const replay = await startRun(ctx, {
      definitionKey: 'demo.multi',
      input: { hello: 'changed' },
      idempotencyKey: 'run-once',
    });
    expect(replay.id).toBe(run.id);
    expect(replay.input).toEqual({ hello: 'world' });

    const all = await listRuns(ctx, { definitionKey: 'demo.multi' });
    expect(all).toHaveLength(1);
  });

  it('validates run inputs and reports unknown runs uniformly', async () => {
    const ctx = member(tenantRuns);
    await expect(startRun(ctx, { definitionKey: 'demo.multi', idempotencyKey: '' })).rejects.toMatchObject({
      code: 'invalid_run_input',
    });
    const unknown = newId();
    await expect(getRun(ctx, { runId: unknown })).rejects.toMatchObject({ code: 'run_not_found' });
    await expect(listRunSteps(ctx, { runId: unknown })).rejects.toMatchObject({ code: 'run_not_found' });
    await expect(listRunStepAttempts(ctx, { runId: unknown })).rejects.toMatchObject({ code: 'run_not_found' });
    await expect(cancelRun(ctx, { runId: unknown, reason: 'x' })).rejects.toMatchObject({ code: 'run_not_found' });
  });
});

// ---------------------------------------------------------------------------
// Event triggers
// ---------------------------------------------------------------------------

describe('event dispatch: durable, idempotent materialization', () => {
  beforeAll(async () => {
    const ctx = member(tenantEvents);
    await registerWorkflow(ctx, {
      key: 'demo.invoice',
      title: 'Invoice reaction',
      spec: { steps: [{ key: 'react' }], eventTriggers: ['invoice.registered'] },
    });
    await registerWorkflow(ctx, {
      key: 'demo.invoice.other',
      title: 'Other',
      spec: { steps: [{ key: 'noop' }], eventTriggers: ['something.else', 'invoice.registered'] },
    });
    await registerWorkflow(ctx, {
      key: 'demo.unrelated',
      title: 'Unrelated',
      spec: { steps: [{ key: 'noop' }] },
    });
  });

  it('starts one run per subscribed active definition, atomically and idempotently', async () => {
    const ctx = member(tenantEvents);
    const first = await dispatchWorkflowEvent(ctx, {
      eventType: 'invoice.registered',
      payload: { invoice: 'inv-9' },
      idempotencyKey: 'evt-9',
    });
    expect(first.replayed).toBe(false);
    expect(first.runsStarted.map((r) => r.definitionKey).sort()).toEqual([
      'demo.invoice',
      'demo.invoice.other',
    ]);
    expect(first.runsStarted.every((r) => r.trigger === 'event')).toBe(true);
    expect(first.runsStarted.every((r) => r.triggerEventId === first.event.id)).toBe(true);
    expect(first.runsStarted.every((r) => r.input !== null && r.input !== undefined)).toBe(true);

    // The event is durable and readable.
    const stored = await getWorkflowEvent(ctx, { eventId: first.event.id });
    expect(stored.eventType).toBe('invoice.registered');
    expect(stored.idempotencyKey).toBe('evt-9');

    // Replaying the same key materializes NOTHING new.
    const replay = await dispatchWorkflowEvent(ctx, {
      eventType: 'invoice.registered',
      payload: { invoice: 'inv-9-again' },
      idempotencyKey: 'evt-9',
    });
    expect(replay.replayed).toBe(true);
    expect(replay.runsStarted).toEqual([]);
    expect(replay.event.id).toBe(first.event.id);
    expect((await listRuns(ctx, { trigger: 'event' })).length).toBe(2);

    // A different event starts a fresh set of runs.
    const second = await dispatchWorkflowEvent(ctx, {
      eventType: 'invoice.registered',
      payload: { invoice: 'inv-10' },
      idempotencyKey: 'evt-10',
    });
    expect(second.runsStarted).toHaveLength(2);
    expect((await listRuns(ctx, { trigger: 'event' })).length).toBe(4);

    // Unsubscribed definitions never run.
    const other = await dispatchWorkflowEvent(ctx, {
      eventType: 'something.else',
      payload: {},
      idempotencyKey: 'evt-11',
    });
    expect(other.runsStarted.map((r) => r.definitionKey)).toEqual(['demo.invoice.other']);
  });

  it('anchors domain events through the events contract (validated reference)', async () => {
    const ctx = member(tenantEvents);
    const domainEvent = await appendEvent(ctx, {
      type: 'invoice.registered',
      payload: { invoice: 'inv-domain' },
      occurredAt: new Date(clockMs).toISOString(),
      actor: { kind: 'system', label: 'erp' },
      source: { kind: 'source', label: 'erp' },
      idempotencyKey: `domain-${newId()}`,
    });
    const dispatch = await dispatchWorkflowEvent(ctx, {
      eventType: 'invoice.registered',
      payload: { via: 'domain-event' },
      domainEventId: domainEvent.id,
      idempotencyKey: 'evt-domain',
    });
    expect(dispatch.event.domainEventId).toBe(domainEvent.id);
    expect(dispatch.runsStarted).toHaveLength(2);

    // An unreadable domain event reference is rejected — never stored.
    await expect(
      dispatchWorkflowEvent(ctx, {
        eventType: 'invoice.registered',
        payload: {},
        domainEventId: newId(),
      }),
    ).rejects.toMatchObject({ code: 'invalid_reference' });
    // Cross-tenant domain events are indistinguishable from missing ones
    // (the events module's not-found, wrapped into this module's
    // invalid_reference — no existence leak either way).
    const foreign = await appendEvent(member(tenantIsoA), {
      type: 'invoice.registered',
      payload: {},
      occurredAt: new Date(clockMs).toISOString(),
      actor: { kind: 'system', label: 'erp' },
      source: { kind: 'source', label: 'erp' },
    });
    await expect(
      dispatchWorkflowEvent(ctx, {
        eventType: 'invoice.registered',
        payload: {},
        domainEventId: foreign.id,
      }),
    ).rejects.toMatchObject({ code: 'invalid_reference' });
  });

  it('validates dispatch inputs and reports unknown events uniformly', async () => {
    const ctx = member(tenantEvents);
    await expect(dispatchWorkflowEvent(ctx, { eventType: 'BAD' })).rejects.toMatchObject({
      code: 'invalid_event_input',
    });
    await expect(getWorkflowEvent(ctx, { eventId: newId() })).rejects.toMatchObject({
      code: 'event_not_found',
    });
  });
});

// ---------------------------------------------------------------------------
// Schedules
// ---------------------------------------------------------------------------

describe('schedules: creation and idempotent firing', () => {
  beforeAll(async () => {
    const ctx = member(tenantSchedules);
    await registerWorkflow(ctx, {
      key: 'demo.scheduled',
      title: 'Scheduled',
      spec: { steps: [{ key: 'tick' }] },
    });
  });

  it('creates an active UTC schedule and validates its inputs', async () => {
    const ctx = member(tenantSchedules);
    const schedule = await createSchedule(ctx, {
      definitionKey: 'demo.scheduled',
      cron: '*/5 * * * *',
      input: { window: 'morning' },
    });
    expect(schedule.active).toBe(true);
    expect(schedule.timezone).toBe('UTC');
    expect(schedule.lastOccurrenceAt).toBeNull();
    expect(schedule.nextOccurrenceAt).toBe('2026-09-24T12:00:00.000Z');
    expect((await listSchedules(ctx, {})).map((s) => s.id)).toContain(schedule.id);
    expect((await listSchedules(ctx, { activeOnly: true })).map((s) => s.id)).toContain(schedule.id);

    await expect(
      createSchedule(ctx, { definitionKey: 'demo.scheduled', cron: 'bad' }),
    ).rejects.toMatchObject({ code: 'invalid_schedule_input' });
    await expect(
      createSchedule(ctx, { definitionKey: 'missing.one', cron: '* * * * *' }),
    ).rejects.toMatchObject({ code: 'definition_not_found' });

    // Deactivation is visible and reversible; unknown ids are not found.
    const off = await setScheduleActive(ctx, { scheduleId: schedule.id, active: false });
    expect(off.active).toBe(false);
    expect((await listSchedules(ctx, { activeOnly: true })).map((s) => s.id)).not.toContain(schedule.id);
    await setScheduleActive(ctx, { scheduleId: schedule.id, active: true });
    await expect(
      setScheduleActive(ctx, { scheduleId: newId(), active: false }),
    ).rejects.toMatchObject({ code: 'schedule_not_found' });
  });

  it('fires each occurrence exactly once across evaluations and restarts', async () => {
    const ctx = member(tenantFire);
    await registerWorkflow(ctx, {
      key: 'demo.scheduled',
      title: 'Scheduled',
      spec: { steps: [{ key: 'tick' }] },
    });
    const schedule = await createSchedule(ctx, {
      definitionKey: 'demo.scheduled',
      cron: '*/5 * * * *',
      input: { p: 1 },
    });
    // created at 11:57:30; advance to 12:03:00 → occurrences in
    // (11:57:30, 12:03:00] = { 12:00 }.
    advance(5 * 60 + 30);
    const sweep1 = await evaluateSchedules(ctx);
    expect(sweep1.schedulesEvaluated).toBeGreaterThanOrEqual(1);
    expect(sweep1.occurrencesFired).toBe(1);
    expect(sweep1.runsStarted).toHaveLength(1);
    expect(sweep1.runsStarted[0]!.trigger).toBe('schedule');
    expect(sweep1.runsStarted[0]!.triggerScheduleId).toBe(schedule.id);
    expect(sweep1.runsStarted[0]!.input).toEqual({ p: 1 });
    expect(sweep1.runsStarted[0]!.idempotencyKey).toBe(
      `sched:${schedule.id}:${Date.parse('2026-09-24T12:00:00Z')}`,
    );

    // Re-evaluating at the same instant fires nothing (ledger dedupe) —
    // this is the "restarted evaluation sweep" case.
    const sweep2 = await evaluateSchedules(ctx);
    expect(sweep2.occurrencesFired).toBe(0);
    expect(sweep2.runsStarted).toEqual([]);

    // Advancing to 12:07 fires exactly the 12:05 occurrence.
    advance(4 * 60);
    const sweep3 = await evaluateSchedules(ctx);
    expect(sweep3.occurrencesFired).toBe(1);
    expect(sweep3.runsStarted[0]!.idempotencyKey).toBe(
      `sched:${schedule.id}:${Date.parse('2026-09-24T12:05:00Z')}`,
    );
    // Total: two scheduled runs.
    expect((await listRuns(ctx, { trigger: 'schedule' })).length).toBe(2);

    // The cursor moved durably.
    const stored = (await listSchedules(ctx, {})).find((s) => s.id === schedule.id)!;
    expect(stored.lastOccurrenceAt).toBe('2026-09-24T12:05:00.000Z');
  });

  it('skips occurrences whose definition retired but advances the clock', async () => {
    const ctx = member(tenantRetired);
    await registerWorkflow(ctx, {
      key: 'demo.retire.soon',
      title: 'Retire soon',
      spec: { steps: [{ key: 'tick' }] },
    });
    const schedule = await createSchedule(ctx, {
      definitionKey: 'demo.retire.soon',
      cron: '*/10 * * * *',
    });
    // Advance to 12:00:00 → the 12:00 occurrence fires while active.
    advance(5 * 60 + 30);
    const sweep = await evaluateSchedules(ctx);
    expect(sweep.occurrencesFired).toBe(1);
    const before = (await listRuns(ctx, { trigger: 'schedule' })).length;

    // Retire the definition, then advance to 12:10:00 — the 12:10
    // occurrence is skipped (no run) but the cursor still advances.
    await getDb().query(
      `UPDATE workflow_definitions SET status = 'retired' WHERE tenant_id = $1 AND key = 'demo.retire.soon'`,
      [tenantRetired],
    );
    advance(10 * 60);
    const sweepRetired = await evaluateSchedules(ctx);
    expect(sweepRetired.occurrencesFired).toBe(0);
    const after = (await listRuns(ctx, { trigger: 'schedule' })).length;
    expect(after).toBe(before);
    const stored = (await listSchedules(ctx, {})).find((s) => s.id === schedule.id)!;
    expect(stored.lastOccurrenceAt).toBe('2026-09-24T12:10:00.000Z');
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation
// ---------------------------------------------------------------------------

describe('tenant isolation (ADR-0001)', () => {
  beforeAll(async () => {
    await registerWorkflow(member(tenantIsoA), {
      key: 'demo.iso',
      title: 'Iso',
      spec: { steps: [{ key: 'only' }], eventTriggers: ['iso.event'] },
    });
  });

  it('makes another tenant entirely invisible across every surface', async () => {
    const ctxA = member(tenantIsoA);
    const ctxB = member(tenantIsoB);
    const run = await startRun(ctxA, { definitionKey: 'demo.iso', idempotencyKey: 'iso-run' });

    // Reads: not found, no existence leak.
    await expect(getRun(ctxB, { runId: run.id })).rejects.toMatchObject({ code: 'run_not_found' });
    await expect(listRunSteps(ctxB, { runId: run.id })).rejects.toMatchObject({ code: 'run_not_found' });
    await expect(getWorkflowDefinition(ctxB, { key: 'demo.iso' })).rejects.toMatchObject({
      code: 'definition_not_found',
    });
    expect(await listRuns(ctxB, {})).toEqual([]);
    expect(await listWorkflowDefinitions(ctxB, {})).toEqual([]);

    // Writes: cannot touch another tenant's run/definition.
    await expect(cancelRun(ctxB, { runId: run.id, reason: 'nope' })).rejects.toMatchObject({
      code: 'run_not_found',
    });
    await expect(
      resumeRun(ctxB, { runId: run.id, payload: {} }),
    ).rejects.toMatchObject({ code: 'run_not_found' });
    await expect(startRun(ctxB, { definitionKey: 'demo.iso' })).rejects.toMatchObject({
      code: 'definition_not_found',
    });

    // The engine's pump is tenant-scoped: pumping tenant B does nothing.
    const engineB = createWorkflowEngine({
      'demo.iso': { only: async () => ({ type: 'done' as const }) },
    });
    expect((await engineB.pump(ctxB)).status).toBe('idle');

    // Event dispatch in tenant B starts nothing in tenant A.
    const dispatchB = await dispatchWorkflowEvent(ctxB, {
      eventType: 'iso.event',
      payload: {},
      idempotencyKey: 'iso-evt-b',
    });
    expect(dispatchB.runsStarted).toEqual([]);
    expect(await listRuns(ctxA, { trigger: 'event' })).toEqual([]);

    // Schedules evaluate only their own tenant.
    await createSchedule(ctxA, { definitionKey: 'demo.iso', cron: '*/5 * * * *' });
    const sweepB = await evaluateSchedules(ctxB);
    expect(sweepB.occurrencesFired).toBe(0);
  });

  it('idempotency keys are tenant-scoped', async () => {
    const ctxA = member(tenantIsoA);
    const ctxB = member(tenantIsoB);
    await registerWorkflow(ctxB, {
      key: 'demo.iso',
      title: 'Iso B',
      spec: { steps: [{ key: 'only' }] },
    });
    const runA = await startRun(ctxA, { definitionKey: 'demo.iso', idempotencyKey: 'shared' });
    const runB = await startRun(ctxB, { definitionKey: 'demo.iso', idempotencyKey: 'shared' });
    expect(runA.id).not.toBe(runB.id);
  });
});

// ---------------------------------------------------------------------------
// Storage-level guarantees (the house pattern: even a caller that
// bypasses the service cannot violate the durability invariants)
// ---------------------------------------------------------------------------

describe('storage-level guarantees', () => {
  interface StorageFixture {
    runId: string;
    stepId: string;
    eventId: string;
    signalId: string;
    attemptId: string;
  }

  async function fixture(): Promise<StorageFixture> {
    const ctx = member(tenantStorage);
    await registerWorkflow(ctx, { key: 'demo.storage', title: 'S', spec: { steps: [{ key: 'only' }] } });
    const run = await startRun(ctx, { definitionKey: 'demo.storage' });
    const steps = await listRunSteps(ctx, { runId: run.id });
    const dispatch = await dispatchWorkflowEvent(ctx, { eventType: 'demo.storage.event', payload: {} });
    const signals = await getDb().query<{ id: string }>(
      `INSERT INTO workflow_run_signals (tenant_id, run_id, kind, payload, delivered_by, delivered_at)
         VALUES ($1, $2, 'resume', '{}'::jsonb, 'tester', $3) RETURNING id`,
      [tenantStorage, run.id, new Date(clockMs)],
    );
    const attempt = await getDb().query<{ id: string }>(
      `INSERT INTO workflow_step_attempts (
         tenant_id, run_id, step_number, invocation, outcome, started_at, finished_at, recorded_by
       ) VALUES ($1, $2, 1, 1, 'completed', $3, $3, 'tester') RETURNING id`,
      [tenantStorage, run.id, new Date(clockMs)],
    );
    return {
      runId: run.id,
      stepId: steps[0]!.id,
      eventId: dispatch.event.id,
      signalId: signals.rows[0]!.id,
      attemptId: attempt.rows[0]!.id,
    };
  }

  it('rejects mutation of append-only evidence and erasure of state', async () => {
    const { runId, eventId, signalId, attemptId } = await fixture();
    await expect(
      getDb().query(`UPDATE workflow_events SET payload = '{}'::jsonb WHERE id = $1`, [eventId]),
    ).rejects.toThrow(/append-only/);
    await expect(getDb().query(`DELETE FROM workflow_events WHERE id = $1`, [eventId])).rejects.toThrow(
      /append-only/,
    );
    await expect(
      getDb().query(`UPDATE workflow_step_attempts SET outcome = 'failed' WHERE id = $1`, [attemptId]),
    ).rejects.toThrow(/append-only/);
    await expect(getDb().query(`DELETE FROM workflow_runs WHERE id = $1`, [runId])).rejects.toThrow(
      /cannot be erased/,
    );
    await expect(getDb().query(`DELETE FROM workflow_run_steps WHERE run_id = $1`, [runId])).rejects.toThrow(
      /cannot be erased/,
    );
    await expect(
      getDb().query(`DELETE FROM workflow_run_signals WHERE id = $1`, [signalId]),
    ).rejects.toThrow(/durable delivery evidence/);
  });

  it('permits ONLY the signal consumption stamp to change', async () => {
    const { signalId } = await fixture();
    await expect(
      getDb().query(`UPDATE workflow_run_signals SET payload = '{"x":1}'::jsonb WHERE id = $1`, [signalId]),
    ).rejects.toThrow(/append-only except consumed_at/);
    await expect(
      getDb().query(`UPDATE workflow_run_signals SET note = 'nope' WHERE id = $1`, [signalId]),
    ).rejects.toThrow(/append-only except consumed_at/);
    // The consumption stamp is exactly the mutable part.
    const consumed = await getDb().query(
      `UPDATE workflow_run_signals SET consumed_at = $2 WHERE id = $1 AND consumed_at IS NULL RETURNING consumed_at`,
      [signalId, new Date(clockMs + 1000)],
    );
    expect(consumed.rows).toHaveLength(1);
  });

  it('enforces the unique dedupe slots at the storage level', async () => {
    const { runId } = await fixture();
    await expect(
      getDb().query(
        `INSERT INTO workflow_step_attempts (
           tenant_id, run_id, step_number, invocation, outcome, error_code, started_at, finished_at, recorded_by
         ) VALUES ($1, $2, 1, 1, 'failed', 'boom', $3, $3, 'tester')`,
        [tenantStorage, runId, new Date(clockMs)],
      ),
    ).rejects.toThrow(/unique/);
  });

  it('enforces the run status shapes even for bypassing writers', async () => {
    const { runId } = await fixture();
    // A live run may not carry terminal fields.
    await expect(
      getDb().query(`UPDATE workflow_runs SET result = '{"x":1}'::jsonb WHERE id = $1`, [runId]),
    ).rejects.toThrow();
    // A pending step may not carry error columns.
    await expect(
      getDb().query(`UPDATE workflow_run_steps SET error_code = 'boom' WHERE run_id = $1`, [runId]),
    ).rejects.toThrow();
    // Terminal states require their terminal timestamps.
    await expect(
      getDb().query(`UPDATE workflow_runs SET status = 'succeeded' WHERE id = $1`, [runId]),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Error typing
// ---------------------------------------------------------------------------

describe('error typing', () => {
  it('exposes typed module errors', () => {
    const error = new WorkflowError('run_not_found', 'missing');
    expect(error.code).toBe('run_not_found');
    expect(error.name).toBe('WorkflowError');
  });
});
