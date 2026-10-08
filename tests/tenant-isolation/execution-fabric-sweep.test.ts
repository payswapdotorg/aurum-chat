// Wave C integration (2026-10-08) — Tenant Isolation Verification · sweep
// for the execution-fabric module (W137: Execution Environment / Agent
// Computer Fabric — the vendor-neutral environment registry, the lease
// state machine over W136 execution runs, and the append-only
// artifact/evidence/checkpoint tails).
//
// REAL two-tenant service proof in the W044 house style (the manifest v11
// registration): tenant A builds fabric state through the public contract
// — an immutable environment definition, a lease acquired over a REAL
// W136 execution plan + execution run (goal → plan → agent execution →
// recorded run, all through the consumed seams), the lease prepared LIVE
// through a registered adapter, a human takeover + explicit hand-back,
// and the artifact/evidence/checkpoint tails — and tenant B must see
// none of it:
//
//   * empty-list invisibility — B's listEnvironmentDefinitions and
//     listFabricLeases are empty before it creates its own state, and
//     the lease-scoped evidence lists (events, artifacts, evidence,
//     checkpoints) refuse a foreign lease id uniformly;
//   * uniform not-found — a FOREIGN definition/lease id and a MISSING
//     one reject identically on every surface (`definition_not_found`
//     on the read + the one-way retirement, `lease_not_found` on the
//     read, every lifecycle transition — prepare, takeover, hand-back,
//     heartbeat, lost, recover, cancel, release, fail — and every
//     append — artifact handoff, evidence, checkpoint), and the mapped
//     `exchange_plan_not_found` / `execution_run_not_found` from the
//     consumed W136 contract cover the composition paths — no existence
//     leak (ADR-0001);
//   * same natural keys coexist per tenant — the tenant-unique defKey
//     lives independently in both tenants, and each tenant's
//     same-shaped definitions and leases stay fully isolated with
//     their evidence tails;
//   * writes never mutate another tenant's rows — B cannot retire A's
//     definition, cannot move or append to A's lease in any way, and
//     cannot even acquire over A's plan or A's execution run (the
//     W136 seam's uniform not-found — the stolen-body precedent).
//
// Scope rules honored here: execution-fabric code is imported ONLY
// through '@/modules/execution-fabric/contract'; the goals/agents/
// agent-exchange fixtures come through their public contracts (the
// consumed seams, exercised as real records — never direct SQL writes);
// the adapter is in-memory WIRING (never domain state), registered
// through the module's own wiring seam.

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
  acquireFabricLease,
  cancelFabricLease,
  createLocalContainerAdapter,
  failFabricLease,
  getEnvironmentDefinition,
  getFabricLease,
  handbackFabricLease,
  heartbeatFabricLease,
  listArtifactHandoffs,
  listEnvironmentDefinitions,
  listFabricLeases,
  listLeaseCheckpoints,
  listLeaseEvents,
  listLeaseEvidence,
  markFabricLeaseLost,
  prepareFabricLease,
  recordArtifactHandoff,
  recordLeaseCheckpoint,
  recordLeaseEvidence,
  recoverFabricLease,
  registerEnvironmentDefinition,
  registerExecutionAdapter,
  releaseFabricLease,
  retireEnvironmentDefinition,
  takeoverFabricLease,
  ExecutionFabricError,
} from '@/modules/execution-fabric/contract';
import type {
  ExecutionFabricErrorCode,
  ExecutionAdapterCapabilityDomain,
} from '@/modules/execution-fabric/contract';
import { createGoal } from '@/modules/goals/contract';
import { registerAgent, submitAgentExecution } from '@/modules/agents/contract';
import { createExecutionPlan, recordExecutionRun } from '@/modules/agent-exchange/contract';

const tenantSweepA = newId();
const tenantSweepB = newId();

function member(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: [] };
}

function administer(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: ['agents:administer'] };
}

async function expectCode(code: ExecutionFabricErrorCode, fn: () => unknown): Promise<void> {
  try {
    await fn();
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(ExecutionFabricError);
    expect((error as ExecutionFabricError).code).toBe(code);
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
    actor: { kind: 'system' as const, label: 'w137-sweep' },
  };
}

/** The tenant-unique defKey BOTH tenants will use (the coexistence proof). */
function sweepWorkspaceDefinition() {
  return {
    defKey: 'sweep-workspace',
    displayName: 'Sweep workspace',
    kind: 'workspace' as const,
    profileScope: 'task' as const,
    networkEgress: 'restricted' as const,
    survivesRestart: true,
    checkpoint: 'durable-checkpoint' as const,
    persistentScope: '/workspace',
    requiredCapabilities: ['filesystem', 'commands'] as ExecutionAdapterCapabilityDomain[],
  };
}

/**
 * The REAL W136 fixture chain (the consumed seam): goal → plan (governed
 * tenant-agent member) → live agent execution → the recorded run — the
 * only legal acquire target for a lease.
 */
async function sweepExchangeFixture(
  ctx: TenantContext,
  admin: TenantContext,
  title: string,
): Promise<{ planId: string; executionRunId: string }> {
  const goal = await createGoal(ctx, sweepGoalInput(title));
  const agent = (await registerAgent(admin, {
    slug: `sweep-specialist-${newId().slice(0, 8)}`,
    displayName: 'Sweep specialist',
    role: 'specialist execution',
    description: 'Executes plan tasks.',
    provider: 'openai-assistants',
    instructions: 'Execute the assigned task and report.',
    permissions: ['observe', 'analyze'],
    runtimeConfig: { assistantId: `asst_w137_sweep_${newId().slice(0, 8)}` },
  })).agent;
  const plan = await createExecutionPlan(ctx, {
    goalId: goal.id,
    objective: `Execute ${title} inside an isolated environment`,
    tasks: [{ taskKey: 'survey', title: 'Survey the site' }],
    members: [{ memberKey: 'lead', kind: 'tenant-agent' as const, role: 'Lead specialist', ref: agent.id }],
  });
  const execution = await submitAgentExecution(ctx, {
    agentId: agent.id,
    task: { instruction: 'Survey the site', context: 'sweep window' },
    requestedPermissions: ['observe'],
  });
  const run = await recordExecutionRun(ctx, {
    planId: plan.id,
    taskKey: 'survey',
    agentExecutionId: execution.id,
    context: { evidenceRefs: ['w137-sweep-site-brief'] },
  });
  return { planId: plan.id, executionRunId: run.id };
}

beforeAll(async () => {
  await runMigrations(getDb());
  // The in-memory adapter wiring (never domain state): the deterministic
  // local-container path — enough to serve the workspace definition's
  // required capability domains. No container engine, no network, ever.
  await registerExecutionAdapter(createLocalContainerAdapter());
});

afterAll(async () => {
  await closeDb();
});

describe('W044 execution-fabric — the environment/lease fabric (W137) is tenant-scoped', () => {
  it("tenant A's definitions, leases and evidence tails are invisible to tenant B; the same defKey and lease shape coexist per tenant", async () => {
    const ctxA = member(tenantSweepA);
    const ctxAAdmin = administer(tenantSweepA);
    const ctxB = member(tenantSweepB);
    const ctxBAdmin = administer(tenantSweepB);

    // ---- Tenant A: the fabric state, through the real W136 seam -------
    const fixtureA = await sweepExchangeFixture(ctxA, ctxAAdmin, 'W137 sweep fabric program A');
    const defA = await registerEnvironmentDefinition(ctxA, sweepWorkspaceDefinition());
    expect(defA.tenantId).toBe(tenantSweepA);
    expect(defA.defKey).toBe('sweep-workspace');
    expect(defA.status).toBe('active');
    const leaseA = await acquireFabricLease(ctxA, {
      definitionId: defA.id,
      planId: fixtureA.planId,
      executionRunId: fixtureA.executionRunId,
    });
    expect(leaseA.tenantId).toBe(tenantSweepA);
    expect(leaseA.status).toBe('preparing');
    const liveA = await prepareFabricLease(ctxA, { leaseId: leaseA.id });
    expect(liveA.status).toBe('live');

    // A human takeover + the explicit hand-back (the W131 control cycle).
    const suspendedA = await takeoverFabricLease(ctxA, {
      leaseId: leaseA.id,
      reason: 'the operator inspects the workspace',
    });
    expect(suspendedA.status).toBe('suspended');
    const resumedA = await handbackFabricLease(ctxA, { leaseId: leaseA.id, note: 'inspection done' });
    expect(resumedA.status).toBe('live');

    // The append-only evidence tails over A's own lease.
    const artifactA = await recordArtifactHandoff(ctxA, {
      leaseId: leaseA.id,
      direction: 'out',
      artifactRef: 'w137-sweep-survey-report',
      artifactKind: 'report',
      digest: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6',
    });
    expect(artifactA.artifactRef).toBe('w137-sweep-survey-report');
    const evidenceA = await recordLeaseEvidence(ctxA, {
      leaseId: leaseA.id,
      captureKind: 'screenshot',
      artifactRef: 'w137-sweep-screen-1',
      verification: 'verified',
    });
    expect(evidenceA.verification).toBe('verified');
    const checkpointA = await recordLeaseCheckpoint(ctxA, {
      leaseId: leaseA.id,
      cursor: 'w137-sweep-session@cursor-1',
      coveredEvidenceRefs: ['w137-sweep-screen-1'],
    });
    expect(checkpointA.cursor).toBe('w137-sweep-session@cursor-1');
    // The lease renews its window (still live, still A's).
    await heartbeatFabricLease(ctxA, { leaseId: leaseA.id });
    const renewedA = await getFabricLease(ctxA, { leaseId: leaseA.id });
    expect(renewedA.status).toBe('live');

    // ---- Tenant B sees none of it ---------------------------------------
    expect(await listEnvironmentDefinitions(ctxB, {})).toHaveLength(0);
    expect(await listFabricLeases(ctxB, {})).toHaveLength(0);

    // Uniform not-founds: a FOREIGN definition id and a MISSING one are
    // indistinguishable on the read and the one-way retirement.
    await expectCode('definition_not_found', () =>
      getEnvironmentDefinition(ctxB, { definitionId: defA.id }),
    );
    await expectCode('definition_not_found', () =>
      getEnvironmentDefinition(ctxB, { definitionId: newId() }),
    );
    await expectCode('definition_not_found', () =>
      retireEnvironmentDefinition(ctxB, { definitionId: defA.id }),
    );

    // A FOREIGN lease id and a MISSING one are indistinguishable on the
    // read, EVERY lifecycle transition and EVERY evidence append.
    await expectCode('lease_not_found', () => getFabricLease(ctxB, { leaseId: leaseA.id }));
    await expectCode('lease_not_found', () => getFabricLease(ctxB, { leaseId: newId() }));
    await expectCode('lease_not_found', () => prepareFabricLease(ctxB, { leaseId: leaseA.id }));
    await expectCode('lease_not_found', () =>
      takeoverFabricLease(ctxB, { leaseId: leaseA.id, reason: 'cross-tenant probe' }),
    );
    await expectCode('lease_not_found', () =>
      handbackFabricLease(ctxB, { leaseId: leaseA.id, note: 'cross-tenant probe' }),
    );
    await expectCode('lease_not_found', () => heartbeatFabricLease(ctxB, { leaseId: leaseA.id }));
    await expectCode('lease_not_found', () =>
      markFabricLeaseLost(ctxB, { leaseId: leaseA.id, detail: 'cross-tenant probe' }),
    );
    await expectCode('lease_not_found', () => recoverFabricLease(ctxB, { leaseId: leaseA.id }));
    await expectCode('lease_not_found', () => recoverFabricLease(ctxB, { leaseId: newId() }));
    await expectCode('lease_not_found', () => cancelFabricLease(ctxB, { leaseId: leaseA.id, reason: 'cross-tenant probe' }));
    await expectCode('lease_not_found', () =>
      releaseFabricLease(ctxB, { leaseId: leaseA.id, reason: 'cross-tenant probe' }),
    );
    await expectCode('lease_not_found', () =>
      failFabricLease(ctxB, { leaseId: leaseA.id, detail: 'cross-tenant probe' }),
    );
    await expectCode('lease_not_found', () =>
      recordArtifactHandoff(ctxB, {
        leaseId: leaseA.id,
        direction: 'in',
        artifactRef: 'stolen',
        artifactKind: 'probe',
      }),
    );
    await expectCode('lease_not_found', () =>
      recordArtifactHandoff(ctxB, {
        leaseId: newId(),
        direction: 'in',
        artifactRef: 'missing',
        artifactKind: 'probe',
      }),
    );
    await expectCode('lease_not_found', () =>
      recordLeaseEvidence(ctxB, {
        leaseId: leaseA.id,
        captureKind: 'screenshot',
        artifactRef: 'stolen',
        verification: 'unverified',
      }),
    );
    await expectCode('lease_not_found', () =>
      recordLeaseCheckpoint(ctxB, { leaseId: leaseA.id, cursor: 'stolen@cursor' }),
    );

    // The lease-scoped list reads refuse a foreign lease id uniformly
    // (the typed-not-found house style — never an existence leak).
    await expectCode('lease_not_found', () => listLeaseEvents(ctxB, { leaseId: leaseA.id }));
    await expectCode('lease_not_found', () => listArtifactHandoffs(ctxB, { leaseId: leaseA.id }));
    await expectCode('lease_not_found', () => listLeaseEvidence(ctxB, { leaseId: leaseA.id }));
    await expectCode('lease_not_found', () => listLeaseCheckpoints(ctxB, { leaseId: leaseA.id }));
    // The lease LIST view filtered over A's definition/run is equally blind.
    expect(await listFabricLeases(ctxB, { definitionId: defA.id })).toEqual([]);
    expect(await listFabricLeases(ctxB, { executionRunId: fixtureA.executionRunId })).toEqual([]);

    // ---- B's own definition first (the coexistence defKey) --------------
    // The tenant-unique defKey 'sweep-workspace' lives independently in B
    // even though A already registered it — per-tenant namespaces only.
    const defB = await registerEnvironmentDefinition(ctxB, sweepWorkspaceDefinition());
    expect(defB.id).not.toBe(defA.id);
    expect(defB.defKey).toBe(defA.defKey);

    // B cannot COMPOSE over A's records either: not over A's definition
    // (the definition gate fires before the consumed seams are touched),
    // not over A's plan, and not over A's execution run on B's own plan
    // (the W136 seam's uniform not-found — the stolen-body precedent).
    await expectCode('definition_not_found', () =>
      acquireFabricLease(ctxB, {
        definitionId: defA.id,
        planId: fixtureA.planId,
        executionRunId: fixtureA.executionRunId,
      }),
    );
    await expectCode('exchange_plan_not_found', () =>
      acquireFabricLease(ctxB, {
        definitionId: defB.id,
        planId: fixtureA.planId,
        executionRunId: fixtureA.executionRunId,
      }),
    );
    await expectCode('exchange_plan_not_found', () =>
      acquireFabricLease(ctxB, {
        definitionId: defB.id,
        planId: newId(),
        executionRunId: newId(),
      }),
    );
    const fixtureB = await sweepExchangeFixture(ctxB, ctxBAdmin, 'W137 sweep fabric program B');
    await expectCode('execution_run_not_found', () =>
      acquireFabricLease(ctxB, {
        definitionId: defB.id,
        planId: fixtureB.planId,
        executionRunId: fixtureA.executionRunId,
      }),
    );

    // ---- B's same-shaped lease is fully its own -------------------------
    const leaseB = await acquireFabricLease(ctxB, {
      definitionId: defB.id,
      planId: fixtureB.planId,
      executionRunId: fixtureB.executionRunId,
    });
    const liveB = await prepareFabricLease(ctxB, { leaseId: leaseB.id });
    expect(liveB.tenantId).toBe(tenantSweepB);
    expect(liveB.status).toBe('live');
    // Each tenant's lists hold exactly their own rows.
    expect((await listEnvironmentDefinitions(ctxA, {})).map((d) => d.id)).toEqual([defA.id]);
    expect((await listEnvironmentDefinitions(ctxB, {})).map((d) => d.id)).toEqual([defB.id]);
    expect((await listFabricLeases(ctxA, {})).map((l) => l.id)).toEqual([leaseA.id]);
    expect((await listFabricLeases(ctxB, {})).map((l) => l.id)).toEqual([leaseB.id]);

    // ---- The evidence tails stay tenant-scoped ---------------------------
    // A's lease carries exactly the artifact, evidence and checkpoint it
    // recorded (plus the lifecycle events); B's lease carries none (its
    // tail is honestly cold until it records its own).
    expect((await listArtifactHandoffs(ctxA, { leaseId: leaseA.id })).map((a) => a.id)).toEqual([
      artifactA.id,
    ]);
    expect((await listLeaseEvidence(ctxA, { leaseId: leaseA.id })).map((e) => e.id)).toEqual([
      evidenceA.id,
    ]);
    expect((await listLeaseCheckpoints(ctxA, { leaseId: leaseA.id })).map((c) => c.id)).toEqual([
      checkpointA.id,
    ]);
    const eventsA = await listLeaseEvents(ctxA, { leaseId: leaseA.id });
    // acquired, prepared, takeover, handback, artifact, evidence, checkpoint
    // (heartbeat renews the window without appending an event).
    expect(eventsA.map((e) => e.kind)).toEqual([
      'acquired',
      'prepared',
      'takeover',
      'handback',
      'artifact',
      'evidence',
      'checkpoint',
    ]);
    expect(await listArtifactHandoffs(ctxB, { leaseId: leaseB.id })).toHaveLength(0);
    expect(await listLeaseEvidence(ctxB, { leaseId: leaseB.id })).toHaveLength(0);
    expect(await listLeaseCheckpoints(ctxB, { leaseId: leaseB.id })).toHaveLength(0);
    expect((await listLeaseEvents(ctxB, { leaseId: leaseB.id })).map((e) => e.kind)).toEqual([
      'acquired',
      'prepared',
    ]);
    // The events tail is list-scoped too: B never sees A's event log.
    await expectCode('lease_not_found', () => listLeaseEvents(ctxB, { leaseId: newId() }));

    // B records its own evidence over ITS lease (the surface serves B
    // normally — isolation is not breakage), and A's tail is unchanged.
    const artifactB = await recordArtifactHandoff(ctxB, {
      leaseId: leaseB.id,
      direction: 'out',
      artifactRef: 'w137-sweep-b-report',
      artifactKind: 'report',
    });
    expect(artifactB.tenantId).toBe(tenantSweepB);
    expect(await listArtifactHandoffs(ctxA, { leaseId: leaseA.id })).toHaveLength(1);
    expect(await listArtifactHandoffs(ctxB, { leaseId: leaseB.id })).toHaveLength(1);
    // A's lease is still live and untouched by any of B's probes.
    expect((await getFabricLease(ctxA, { leaseId: leaseA.id })).status).toBe('live');
    expect((await getEnvironmentDefinition(ctxA, { definitionId: defA.id })).status).toBe('active');
  });
});
