// W044 — Tenant Isolation Verification · application- and repository-
// boundary sweep for the agent-supervision module (W098 — Persistent
// Agent Supervision and Recovery).
//
// The agent-supervision module is information-bearing domain state
// (supervision records with health, review schedules, budgets and
// permission ceilings; reviews; the append-only event trail; the
// exactly-once budget ledger; supervisor sessions — all tenant-scoped),
// so this is a REAL two-tenant contract sweep, the workflow-sweep
// doctrine (W080, the module-family precedent):
//   * supervision records are invisible across tenants with the uniform
//     not-found code — no existence leak — on every read AND every
//     control write (update/grant/suspend/resume/review/pump);
//   * THE PUMP IS TENANT-SCOPED: pumping tenant B never fires tenant
//     A's due reviews, never ledgers tenant A's spend and never
//     advances tenant A's waiting states;
//   * supervised work admission cannot cross tenants (a foreign agent
//     reads the same as a missing one);
//   * SESSION RECOVERY IS TENANT-SCOPED: beginning a session in tenant
//     B never recovers tenant A's expired sessions;
//   * lists (records, events, reviews, budget entries, sessions) stay
//     per-tenant;
//   * authority claims never widen tenant scope (the omnipotent probe);
//   * repository boundary — every agent-supervision table carries a
//     NOT NULL uuid tenant_id, and after the fixtures ran no row in ANY
//     tenant-scoped table escaped the sweep's two tenants.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import { registerAgent } from '@/modules/agents/contract';
import {
  beginSupervisorSession,
  completeSupervisionReview,
  endSupervisorSession,
  getSupervision,
  getSupervisionReview,
  getSupervisorSession,
  grantSupervisionBudget,
  heartbeatSupervisorSession,
  listSupervisionBudgetEntries,
  listSupervisionEvents,
  listSupervisionReviews,
  listSupervisions,
  listSupervisorSessions,
  pumpSupervision,
  registerSupervisedAgent,
  resumeSupervision,
  submitSupervisedExecution,
  suspendSupervision,
  updateSupervision,
} from '@/modules/agent-supervision/contract';
import {
  assertTenantPartition,
  expectUniformNotFound,
  member,
  memberWith,
  omnipotent,
  runMigrations,
  tableColumns,
} from './harness';

const tenantA = newId();
const tenantB = newId();
const ctxA = memberWith(tenantA, ['agents:administer']);
const ctxB = memberWith(tenantB, ['agents:administer']);

const SUPERVISION_TABLES = [
  'agent_supervision_records',
  'agent_supervision_events',
  'agent_supervision_reviews',
  'agent_supervision_budget_entries',
  'agent_supervisor_sessions',
];

/** Registers an agent + supervision in `tenantId` under `slug`. */
async function makeSupervised(tenantId: string, slug: string): Promise<string> {
  const ctx = memberWith(tenantId, ['agents:administer']);
  const registered = await registerAgent(ctx, {
    slug,
    displayName: slug,
    role: 'operations',
    description: null,
    provider: 'langgraph',
    instructions: 'Do the supervised thing.',
    runtimeConfig: { assistantId: `asst_${slug}` },
    permissions: ['observe', 'analyze'],
  });
  const { supervision } = await registerSupervisedAgent(ctx, {
    agentId: registered.agent.id,
    reviewIntervalSeconds: 3_600,
    budgetMinor: 100_000,
  });
  return supervision.agentId;
}

let agentA: string;
let agentB: string;

beforeAll(async () => {
  await runMigrations(getDb());
  // Both tenants supervise agents under the SAME slug — per-tenant
  // agent namespaces (the agents module's identity discipline).
  agentA = await makeSupervised(tenantA, 'iso-analyst');
  agentB = await makeSupervised(tenantB, 'iso-analyst');
});

afterAll(async () => {
  const { closeDb } = await import('@/infra/db');
  await closeDb();
});

describe('W044 sweep — agent-supervision (W098 persistent supervision)', () => {
  it('isolates supervision records across tenants on every read and control write', async () => {
    const own = await getSupervision(ctxA, { agentId: agentA });
    expect(own.tenantId).toBe(tenantA);
    expect(own.status).toBe('active');

    // Cross-tenant reads AND control writes are uniformly not-found —
    // a foreign agent's supervision is indistinguishable from none.
    await expectUniformNotFound(
      'supervision_not_found',
      () => getSupervision(ctxB, { agentId: agentA }),
      () => getSupervision(ctxA, { agentId: newId() }),
    );
    await expectUniformNotFound(
      'supervision_not_found',
      () => updateSupervision(ctxB, { agentId: agentA, ownerPrincipal: 'thief' }),
      () => updateSupervision(ctxA, { agentId: newId(), ownerPrincipal: 'x' }),
    );
    await expectUniformNotFound(
      'supervision_not_found',
      () => grantSupervisionBudget(ctxB, { agentId: agentA, additionalMinor: 1 }),
      () => grantSupervisionBudget(ctxA, { agentId: newId(), additionalMinor: 1 }),
    );
    await expectUniformNotFound(
      'supervision_not_found',
      () => suspendSupervision(ctxB, { agentId: agentA, reason: 'nope' }),
      () => suspendSupervision(ctxA, { agentId: newId(), reason: 'nope' }),
    );
    await expectUniformNotFound(
      'supervision_not_found',
      () => resumeSupervision(ctxB, { agentId: agentA }),
      () => resumeSupervision(ctxA, { agentId: newId() }),
    );
    await expectUniformNotFound(
      'supervision_not_found',
      () => completeSupervisionReview(ctxB, { agentId: agentA, outcome: 'continue', rationale: 'x' }),
      () => completeSupervisionReview(ctxA, { agentId: newId(), outcome: 'continue', rationale: 'x' }),
    );
    await expectUniformNotFound(
      'supervision_not_found',
      () => pumpSupervision(ctxB, { agentId: agentA }),
      () => pumpSupervision(ctxA, { agentId: newId() }),
    );

    // Nothing moved for tenant A through all of tenant B's attempts.
    expect(await getSupervision(ctxA, { agentId: agentA })).toMatchObject({
      status: 'active',
      ownerPrincipal: own.ownerPrincipal,
      budgetMinor: 100_000,
    });
  });

  it('refuses supervised work admission for a foreign agent (no existence leak)', async () => {
    await expectUniformNotFound(
      'supervision_not_found',
      () =>
        submitSupervisedExecution(member(tenantB), {
          agentId: agentA,
          task: { duty: 'x' },
          requestedPermissions: ['observe'],
        }),
      () =>
        submitSupervisedExecution(member(tenantA), {
          agentId: newId(),
          task: { duty: 'x' },
          requestedPermissions: ['observe'],
        }),
    );
  });

  it('keeps the pump tenant-scoped (pumping B never fires A\'s due review)', async () => {
    // Age BOTH tenants' review cursators past due (fixture manipulation
    // at the repository boundary — the sweep owns its data).
    await getDb().query(
      `UPDATE agent_supervision_records SET next_review_at = now() - interval '1 hour'
        WHERE tenant_id IN ($1, $2) AND agent_id IN ($3, $4)`,
      [tenantA, tenantB, agentA, agentB],
    );

    // Drain tenant B's pumpable supervision work.
    let firedB = false;
    for (let i = 0; i < 6 && !firedB; i += 1) {
      const outcome = await pumpSupervision(ctxB, { agentId: agentB });
      if (outcome.status === 'idle') break;
      expect(outcome.agentId).toBe(agentB);
      if (outcome.status === 'review_due') firedB = true;
    }
    expect(firedB, "tenant B's pump must fire tenant B's due review").toBe(true);
    expect((await getSupervision(ctxB, { agentId: agentB })).status).toBe('waiting_review');

    // Tenant A's record is untouched by all of B's pumping.
    expect((await getSupervision(ctxA, { agentId: agentA })).status).toBe('active');

    // Pumping tenant A fires A's review only.
    const outcomeA = await pumpSupervision(ctxA, { agentId: agentA });
    expect(outcomeA.status).toBe('review_due');
    expect((await getSupervision(ctxA, { agentId: agentA })).status).toBe('waiting_review');
    expect((await getSupervision(ctxB, { agentId: agentB })).status).toBe('waiting_review');

    // Settle both so later fixtures start from a clean state.
    await completeSupervisionReview(ctxA, { agentId: agentA, outcome: 'continue', rationale: 'ok' });
    await completeSupervisionReview(ctxB, { agentId: agentB, outcome: 'continue', rationale: 'ok' });
  });

  it('scopes reviews, events, budget entries and sessions to their tenant', async () => {
    const reviewsA = await listSupervisionReviews(ctxA, { agentId: agentA });
    expect(reviewsA).toHaveLength(1);
    const reviewA = reviewsA[0]!;
    await expectUniformNotFound(
      'review_not_found',
      () => getSupervisionReview(ctxB, { reviewId: reviewA.id }),
      () => getSupervisionReview(ctxA, { reviewId: newId() }),
    );
    expect(await listSupervisionReviews(ctxB, { agentId: agentA })).toEqual([]);

    const eventsA = await listSupervisionEvents(ctxA, { agentId: agentA, limit: 500 });
    expect(eventsA.length).toBeGreaterThan(0);
    expect(eventsA.every((event) => event.tenantId === tenantA)).toBe(true);
    expect(await listSupervisionEvents(ctxB, { agentId: agentA, limit: 500 })).toEqual([]);

    expect(await listSupervisionBudgetEntries(ctxB, { agentId: agentA })).toEqual([]);

    // Sessions: cross-tenant lifecycle operations are uniformly
    // not-found, and lists stay per-tenant.
    const sessionA = await beginSupervisorSession(ctxA, { leaseSeconds: 3_600 });
    await expectUniformNotFound(
      'session_not_found',
      () => getSupervisorSession(ctxB, { sessionId: sessionA.id }),
      () => getSupervisorSession(ctxA, { sessionId: newId() }),
    );
    await expectUniformNotFound(
      'session_not_found',
      () => heartbeatSupervisorSession(ctxB, { sessionId: sessionA.id }),
      () => heartbeatSupervisorSession(ctxA, { sessionId: newId() }),
    );
    await expectUniformNotFound(
      'session_not_found',
      () => endSupervisorSession(ctxB, { sessionId: sessionA.id }),
      () => endSupervisorSession(ctxA, { sessionId: newId() }),
    );
    expect((await getSupervisorSession(ctxA, { sessionId: sessionA.id })).endedAt).toBeNull();
    expect(
      (await listSupervisorSessions(ctxA, { live: true })).map((session) => session.id),
    ).toContain(sessionA.id);
    expect(await listSupervisorSessions(ctxB, { live: true })).toEqual([]);
  });

  it('recovers expired sessions only within the recovering session\'s tenant', async () => {
    // Both tenants run a supervisor whose lease lapses.
    const deadA = await beginSupervisorSession(ctxA, { leaseSeconds: 60 });
    const deadB = await beginSupervisorSession(ctxB, { leaseSeconds: 60 });
    await getDb().query(
      `UPDATE agent_supervisor_sessions SET lease_expires_at = now() - interval '5 minutes'
        WHERE id IN ($1, $2)`,
      [deadA.id, deadB.id],
    );

    // Tenant B's fresh supervisor recovers ONLY tenant B's dead session.
    const freshB = await beginSupervisorSession(ctxB, { leaseSeconds: 3_600 });
    expect((await getSupervisorSession(ctxB, { sessionId: deadB.id })).endReason).toBe(
      'lease_expired_recovered',
    );
    expect((await getSupervisorSession(ctxB, { sessionId: deadB.id })).recoveredBySessionId).toBe(
      freshB.id,
    );
    // Tenant A's dead session is untouched by B's recovery.
    expect((await getSupervisorSession(ctxA, { sessionId: deadA.id })).endReason).toBeNull();

    // Tenant A's own fresh supervisor recovers it.
    const freshA = await beginSupervisorSession(ctxA, { leaseSeconds: 3_600 });
    expect((await getSupervisorSession(ctxA, { sessionId: deadA.id })).endReason).toBe(
      'lease_expired_recovered',
    );
    expect((await getSupervisorSession(ctxA, { sessionId: deadA.id })).recoveredBySessionId).toBe(
      freshA.id,
    );

    // The recovery events landed in their own tenants' trails only.
    const eventsB = await listSupervisionEvents(ctxB, { sessionId: deadB.id });
    expect(eventsB.map((event) => event.kind)).toContain('session_recovered');
    expect(await listSupervisionEvents(ctxA, { sessionId: deadB.id })).toEqual([]);
  });

  it('authority claims never widen tenant scope (the omnipotent probe)', async () => {
    const godB = omnipotent(tenantB);
    await expect(getSupervision(godB, { agentId: agentA })).rejects.toMatchObject({
      code: 'supervision_not_found',
    });
    await expect(
      pumpSupervision(godB, { agentId: agentA }),
    ).rejects.toMatchObject({ code: 'supervision_not_found' });
    // The omnipotent principal of tenant B sees exactly what a plain
    // member of tenant B sees — never a row of tenant A.
    const godRecords = await listSupervisions(godB, {});
    const plainRecords = await listSupervisions(member(tenantB), {});
    expect(godRecords.map((record) => record.id).sort()).toEqual(
      plainRecords.map((record) => record.id).sort(),
    );
    expect(godRecords.every((record) => record.tenantId === tenantB)).toBe(true);
    // Pumping as the omnipotent principal of B advances only tenant B's
    // supervision — tenant A's statuses never move.
    const before = (await listSupervisions(ctxA, {})).map((record) => [record.id, record.status]);
    for (const record of plainRecords) {
      await pumpSupervision(godB, { agentId: record.agentId });
    }
    const after = (await listSupervisions(ctxA, {})).map((record) => [record.id, record.status]);
    expect(after).toEqual(before);
  });

  it('carries a NOT NULL uuid tenant_id on every agent-supervision table (repository boundary)', async () => {
    const columns = await tableColumns();
    for (const table of SUPERVISION_TABLES) {
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
