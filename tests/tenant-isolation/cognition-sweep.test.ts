// W044 — Tenant Isolation Verification · application-boundary sweep for the
// cognition-layer modules: missions (W011), knowledge-acquisition (W012),
// cognition (W013), processes (W016) and capabilities (W017).
//
// Same doctrine as the other sweeps: two tenants, contracts driven for both,
// cross-tenant reads/writes uniform not-found (ADR-0001), listings disjoint,
// per-tenant natural keys (mission titles, process names, capability names,
// idempotency keys), and — the deep part of this layer — evidence-bearing
// reconstructions and acquisition plans may never draw on another tenant's
// events or missions. Cross-module imports go through contracts only.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import {
  abandonExecution,
  getExecution,
  getExecutionStep,
  listExecutions,
  runNextStage,
  startExecution,
} from '@/modules/cognition/contract';
import {
  getAcquisitionPlan,
  listAcquisitionPlans,
  planNextAcquisition,
  recordAcquisitionOutcome,
} from '@/modules/knowledge-acquisition/contract';
import {
  abandonMission,
  completeMission,
  createMission,
  getMission,
  getMissionVersion,
  listMissions,
  listMissionVersions,
  reviseMission,
} from '@/modules/missions/contract';
import { listObservations, recordObservation } from '@/modules/observations/contract';
import {
  getProcess,
  getProcessFinding,
  listProcesses,
  listProcessFindings,
  listProcessVersions,
  reconstructProcess,
} from '@/modules/processes/contract';
import { recordUnknown } from '@/modules/epistemics/contract';
import {
  analyzeGaps,
  getCapability,
  getCapabilityVersion,
  listCapabilities,
  listCapabilityVersions,
  listRequirements,
  listSupplies,
  registerCapability,
  registerRequirement,
  registerSupply,
  reviseCapability,
  getRequirement,
  getSupply,
} from '@/modules/capabilities/contract';
import { appendEvent } from '@/modules/events/contract';
import { assertTenantPartition, expectUniformNotFound, member, runMigrations } from './harness';

const tenantA = newId();
const tenantB = newId();
const tenantC = newId(); // empty control tenant (process evidence partition)
const ctxA = member(tenantA);
const ctxB = member(tenantB);
const ctxC = member(tenantC);

const T0 = '2026-09-14T09:15:00Z';
const PERSON_1 = '1a2b3c4d-0000-4000-8000-0000000000p1';

beforeAll(async () => {
  await runMigrations(getDb());
});

afterAll(async () => {
  await closeDb();
});

function missionInput(overrides: Record<string, unknown> = {}) {
  return {
    title: 'Churn root cause',
    knowledgeObjective: 'Why did churn rise in Q3?',
    informationValue: 0.8,
    urgency: 'high' as const,
    currentConfidence: 0.1,
    targetConfidence: 0.85,
    investigationBudget: { amount: 250_00, currency: 'EUR' },
    rewardBudget: { amount: 50_00, currency: 'EUR' },
    candidateSources: [{ kind: 'system' as const, label: 'billing-export' }],
    completionCriteria: 'A validated root-cause explanation with confidence >= 0.85.',
    actor: { kind: 'person' as const, id: newId() },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// missions (W011)
// ---------------------------------------------------------------------------

describe('W044 missions — learning missions are tenant-scoped', () => {
  it('gives the same mission title independent rows per tenant', async () => {
    const missionA = await createMission(ctxA, missionInput());
    const missionB = await createMission(ctxB, missionInput());
    expect(missionA.id).not.toBe(missionB.id);
    expect(missionA.tenantId).toBe(tenantA);
    expect(missionB.tenantId).toBe(tenantB);
    expect((await listMissions(ctxA, {})).map((mission) => mission.id)).toContain(missionA.id);
    expect((await listMissions(ctxB, {})).map((mission) => mission.id)).not.toContain(missionA.id);
  });

  it('fails cross-tenant reads of missions and versions uniformly', async () => {
    const missionA = await createMission(ctxA, missionInput());
    await expectUniformNotFound(
      'mission_not_found',
      () => getMission(ctxB, missionA.id),
      () => getMission(ctxB, newId()),
    );
    await expectUniformNotFound(
      'mission_version_not_found',
      () => getMissionVersion(ctxB, { missionId: missionA.id, version: 1 }),
      () => getMissionVersion(ctxB, { missionId: newId(), version: 1 }),
    );
    await expect(listMissionVersions(ctxB, { missionId: missionA.id })).rejects.toMatchObject({
      code: 'mission_not_found',
    });
  });

  it('rejects cross-tenant mission writes before any mutation', async () => {
    const missionA = await createMission(ctxA, missionInput());
    const actor = { kind: 'person' as const, id: newId() };

    await expect(
      reviseMission(ctxB, { missionId: missionA.id, title: 'Pwned by B', actor }),
    ).rejects.toMatchObject({ code: 'mission_not_found' });
    await expect(
      completeMission(ctxB, {
        missionId: missionA.id,
        achievedConfidence: 0.9,
        outcome: 'pwned',
        actor,
      }),
    ).rejects.toMatchObject({ code: 'mission_not_found' });
    await expect(
      abandonMission(ctxB, { missionId: missionA.id, reason: 'cross-tenant pwn', actor }),
    ).rejects.toMatchObject({ code: 'mission_not_found' });

    const still = await getMission(ctxA, missionA.id);
    expect(still.content.status).toBe('active');
  });

  it('rejects missions referencing another tenant unknowns', async () => {
    const unknownA = await recordUnknown(ctxA, {
      question: 'Which pricing tier drives the churn spike?',
      consequence: 'Churn reduction cannot be prioritized without it.',
    });
    await expect(
      createMission(ctxB, missionInput({ unknownIds: [unknownA.id] })),
    ).rejects.toMatchObject({ code: 'invalid_unknown_ref' });
  });
});

// ---------------------------------------------------------------------------
// knowledge-acquisition (W012)
// ---------------------------------------------------------------------------

describe('W044 knowledge-acquisition — plans are tenant-scoped', () => {
  it('fails cross-tenant planning, reads and outcomes uniformly', async () => {
    const missionA = await createMission(ctxA, missionInput());
    const planA = await planNextAcquisition(ctxA, {
      missionId: missionA.id,
      candidates: [
        {
          kind: 'system',
          id: null,
          label: 'billing-export',
          relevance: 0.5,
          reliability: 0.5,
          freshness: 0.5,
          authority: 0.5,
          expectedQuality: 0.5,
          priorContributionValue: 0.5,
          cost: 0,
          access: 'allowed',
        },
      ],
      actor: { kind: 'system', label: 'aurum-cognition' },
      rationale: null,
    });

    // B cannot plan against A's mission.
    await expect(
      planNextAcquisition(ctxB, {
        missionId: missionA.id,
        candidates: [
          {
            kind: 'system',
            id: null,
            label: 'billing-export',
            relevance: 0.5,
            reliability: 0.5,
            freshness: 0.5,
            authority: 0.5,
            expectedQuality: 0.5,
            priorContributionValue: 0.5,
            cost: 0,
            access: 'allowed',
          },
        ],
        actor: { kind: 'system', label: 'aurum-cognition' },
        rationale: null,
      }),
    ).rejects.toMatchObject({ code: 'mission_not_found' });

    await expectUniformNotFound(
      'plan_not_found',
      () => getAcquisitionPlan(ctxB, planA.id),
      () => getAcquisitionPlan(ctxB, newId()),
    );
    await expect(
      recordAcquisitionOutcome(ctxB, {
        planId: planA.id,
        outcome: 'answered',
        evidence: {
          payload: { answer: 'pwned' },
          confidence: { value: 0.8, method: 'source_trust', basis: 'pwn' },
        },
      }),
    ).rejects.toMatchObject({ code: 'plan_not_found' });

    expect(await listAcquisitionPlans(ctxB, {})).toEqual([]);
    expect(await listAcquisitionPlans(ctxB, { missionId: missionA.id })).toEqual([]);
  });

  it('keeps acquisition answers (observations) in the answering tenant only', async () => {
    const missionA = await createMission(ctxA, missionInput());
    const planA = await planNextAcquisition(ctxA, {
      missionId: missionA.id,
      candidates: [
        {
          kind: 'system',
          id: null,
          label: 'billing-export',
          relevance: 0.5,
          reliability: 0.5,
          freshness: 0.5,
          authority: 0.5,
          expectedQuality: 0.5,
          priorContributionValue: 0.5,
          cost: 0,
          access: 'allowed',
        },
      ],
      actor: { kind: 'system', label: 'aurum-cognition' },
      rationale: null,
    });
    const before = (await listObservations(ctxB, {})).length;
    const answered = await recordAcquisitionOutcome(ctxA, {
      planId: planA.id,
      outcome: 'answered',
      evidence: {
        payload: { answer: 'Pricing drove churn.' },
        confidence: { value: 0.8, method: 'source_trust', basis: 'direct account' },
      },
    });
    expect(answered.outcome?.outcome).toBe('answered');
    const after = (await listObservations(ctxB, {})).length;
    expect(after).toBe(before); // the observation A minted never lands in B
  });
});

// ---------------------------------------------------------------------------
// cognition (W013)
// ---------------------------------------------------------------------------

describe('W044 cognition — executions and steps are tenant-scoped', () => {
  it('fails cross-tenant reads, advances and abandons uniformly', async () => {
    const executionA = await startExecution(ctxA, {
      trigger: { kind: 'system', label: 'alpha cycle' },
      focus: { topics: ['churn'], entities: [] },
      actor: { kind: 'system', label: 'aurum-cognition' },
      rationale: 'W044 fixture',
    });
    // Run the observation stage once so a real step exists.
    await runNextStage(ctxA, {
      executionId: executionA.id,
      stage: 'observation',
      record: [
        {
          kind: 'channel.message',
          payload: { text: 'alpha observation stage' },
          observedAt: T0,
          source: { kind: 'source', label: 'slack' },
          channel: 'slack',
          confidence: { value: 0.8, method: 'source_trust' },
        },
      ],
    });

    await expectUniformNotFound(
      'execution_not_found',
      () => getExecution(ctxB, { executionId: executionA.id }),
      () => getExecution(ctxB, { executionId: newId() }),
    );
    await expect(
      getExecutionStep(ctxB, { executionId: executionA.id, stage: 'observation' }),
    ).rejects.toMatchObject({ code: 'execution_not_found' });
    await expect(
      runNextStage(ctxB, { executionId: executionA.id, stage: 'evidence-memory' }),
    ).rejects.toMatchObject({ code: 'execution_not_found' });
    await expect(
      abandonExecution(ctxB, { executionId: executionA.id, reason: 'cross-tenant pwn' }),
    ).rejects.toMatchObject({ code: 'execution_not_found' });

    expect((await listExecutions(ctxB, {})).map((execution) => execution.id)).not.toContain(
      executionA.id,
    );
    // A's execution is still healthy after B's probes.
    const still = await getExecution(ctxA, { executionId: executionA.id });
    expect(still.state).toBe('running');
  });

  it('keeps observation triggers indistinguishable across tenants', async () => {
    const foreignObservation = await recordObservation(ctxB, {
      kind: 'channel.message',
      payload: { text: 'beta trigger source' },
      observedAt: T0,
      source: { kind: 'person', label: 'office-manager' },
      channel: 'whatsapp',
      confidence: { value: 0.9, method: 'source_trust' },
    });
    const startWithTrigger = (observationId: string) =>
      startExecution(ctxA, {
        trigger: { kind: 'observation', id: observationId },
        focus: { topics: ['churn'], entities: [] },
        actor: { kind: 'system', label: 'aurum-cognition' },
        rationale: 'W044 fixture',
      });
    // Foreign and missing observation triggers share the same code — no leak.
    await expect(startWithTrigger(foreignObservation.id)).rejects.toMatchObject({
      code: 'invalid_start_input',
    });
    await expect(startWithTrigger(newId())).rejects.toMatchObject({
      code: 'invalid_start_input',
    });
  });
});

// ---------------------------------------------------------------------------
// processes (W016)
// ---------------------------------------------------------------------------

describe('W044 processes — reconstructions draw on in-tenant evidence only', () => {
  const EVENT_TYPES = ['invoice.registered', 'invoice.reviewed', 'invoice.approved'];

  async function seedInvoiceFlow(ctx: TenantContext, correlationId: string, note: string) {
    await appendEvent(ctx, {
      type: 'invoice.registered',
      payload: { note },
      occurredAt: '2026-09-14T08:00:00Z',
      actor: { kind: 'person', id: PERSON_1 },
      source: { kind: 'system', label: 'test-harness' },
      correlationId,
    });
    await appendEvent(ctx, {
      type: 'invoice.reviewed',
      payload: { note },
      occurredAt: '2026-09-14T08:10:00Z',
      actor: { kind: 'person', id: PERSON_1 },
      source: { kind: 'system', label: 'test-harness' },
      correlationId,
    });
    await appendEvent(ctx, {
      type: 'invoice.approved',
      payload: { note },
      occurredAt: '2026-09-14T08:20:00Z',
      actor: { kind: 'person', id: PERSON_1 },
      source: { kind: 'system', label: 'test-harness' },
      correlationId,
    });
  }

  it('gives the same process name independent versions per tenant', async () => {
    await seedInvoiceFlow(ctxA, newId(), 'alpha flow');
    await seedInvoiceFlow(ctxB, newId(), 'beta flow');

    const processA = await reconstructProcess(ctxA, {
      name: 'Invoice approval',
      scope: { eventTypes: EVENT_TYPES },
      actor: { kind: 'person', id: PERSON_1, label: 'Ops lead' },
      rationale: 'W044 fixture',
    });
    const processB = await reconstructProcess(ctxB, {
      name: 'Invoice approval',
      scope: { eventTypes: EVENT_TYPES },
      actor: { kind: 'person', id: PERSON_1, label: 'Ops lead' },
      rationale: 'W044 fixture',
    });
    expect(processA.id).not.toBe(processB.id);
    expect(processA.version).toBe(1);
    expect(processB.version).toBe(1); // independent version history

    expect((await listProcesses(ctxB, {})).map((process) => process.id)).not.toContain(processA.id);
  });

  it('fails cross-tenant reads of processes, versions and findings uniformly', async () => {
    await seedInvoiceFlow(ctxA, newId(), 'alpha flow 2');
    const processA = await reconstructProcess(ctxA, {
      name: 'Invoice approval 2',
      scope: { eventTypes: EVENT_TYPES },
      actor: { kind: 'person', id: PERSON_1, label: 'Ops lead' },
    });
    const findings = await listProcessFindings(ctxA, { processId: processA.id, limit: 500 });
    expect(findings.length).toBeGreaterThan(0);
    const findingA = findings[0]!;

    await expectUniformNotFound(
      'process_not_found',
      () => getProcess(ctxB, processA.id),
      () => getProcess(ctxB, newId()),
    );
    await expect(listProcessVersions(ctxB, { processId: processA.id })).rejects.toMatchObject({
      code: 'process_not_found',
    });
    await expect(listProcessFindings(ctxB, { processId: processA.id })).rejects.toMatchObject({
      code: 'process_not_found',
    });
    await expectUniformNotFound(
      'finding_not_found',
      () => getProcessFinding(ctxB, { findingId: findingA.id }),
      () => getProcessFinding(ctxB, { findingId: newId() }),
    );
  });

  it('never ingests another tenant events into a reconstruction (empty control tenant)', async () => {
    await seedInvoiceFlow(ctxA, newId(), 'alpha secret flow');
    // Tenant C has NO events at all; its reconstruction over the exact same
    // scope must see zero occurrences — A's evidence never enters C.
    const processC = await reconstructProcess(ctxC, {
      name: 'Cross probe',
      scope: { eventTypes: EVENT_TYPES },
      actor: { kind: 'system', label: 'W044' },
    });
    const findingsC = await listProcessFindings(ctxC, { processId: processC.id, limit: 500 });
    expect(findingsC).toEqual([]);
    // And A's reconstruction over the same scope DID find evidence — the
    // partition is by tenant, not by scope.
    const processA = await reconstructProcess(ctxA, {
      name: 'Invoice approval 3',
      scope: { eventTypes: EVENT_TYPES },
      actor: { kind: 'system', label: 'W044' },
    });
    const findingsA = await listProcessFindings(ctxA, { processId: processA.id, limit: 500 });
    expect(findingsA.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// capabilities (W017)
// ---------------------------------------------------------------------------

describe('W044 capabilities — the capability graph is tenant-scoped', () => {
  const ACTOR = { kind: 'person' as const, id: newId(), label: 'Ops lead' };

  it('gives the same capability name independent rows per tenant', async () => {
    const capA = await registerCapability(ctxA, {
      name: 'German-language support',
      description: 'Customer-facing support in German',
      actor: ACTOR,
    });
    const capB = await registerCapability(ctxB, {
      name: 'German-language support',
      description: 'Customer-facing support in German',
      actor: ACTOR,
    });
    expect(capA.id).not.toBe(capB.id);
    expect((await listCapabilities(ctxB, {})).map((capability) => capability.id)).not.toContain(
      capA.id,
    );
  });

  it('fails cross-tenant reads of capabilities, supplies and requirements uniformly', async () => {
    const capA = await registerCapability(ctxA, {
      name: `Rust development ${newId().slice(0, 6)}`,
      actor: ACTOR,
    });
    const supplyA = await registerSupply(ctxA, {
      capabilityId: capA.id,
      supplier: { kind: 'employee', label: 'Dana' },
      level: 0.5,
      capacity: 10,
      actor: ACTOR,
    });
    const requirementA = await registerRequirement(ctxA, {
      capabilityId: capA.id,
      source: { kind: 'goal', label: 'Docs excellence' },
      level: 0.7,
      actor: ACTOR,
    });

    await expectUniformNotFound(
      'capability_not_found',
      () => getCapability(ctxB, capA.id),
      () => getCapability(ctxB, newId()),
    );
    await expectUniformNotFound(
      'capability_version_not_found',
      () => getCapabilityVersion(ctxB, { capabilityId: capA.id, version: 1 }),
      () => getCapabilityVersion(ctxB, { capabilityId: newId(), version: 1 }),
    );
    await expect(listCapabilityVersions(ctxB, { capabilityId: capA.id })).rejects.toMatchObject({
      code: 'capability_not_found',
    });
    await expectUniformNotFound(
      'supply_not_found',
      () => getSupply(ctxB, supplyA.id),
      () => getSupply(ctxB, newId()),
    );
    await expectUniformNotFound(
      'requirement_not_found',
      () => getRequirement(ctxB, requirementA.id),
      () => getRequirement(ctxB, newId()),
    );

    expect(await listSupplies(ctxB, {})).toEqual([]);
    expect(await listRequirements(ctxB, {})).toEqual([]);
    expect(await analyzeGaps(ctxB, {})).toEqual([]);
  });

  it('rejects cross-tenant graph writes before any mutation', async () => {
    const capA = await registerCapability(ctxA, {
      name: `Cross guard ${newId().slice(0, 6)}`,
      actor: ACTOR,
    });
    const supplyA = await registerSupply(ctxA, {
      capabilityId: capA.id,
      supplier: { kind: 'employee', label: 'Dana' },
      level: 0.4,
      actor: ACTOR,
    });

    await expect(
      reviseCapability(ctxB, { capabilityId: capA.id, description: 'Pwned by B', actor: ACTOR }),
    ).rejects.toMatchObject({ code: 'capability_not_found' });
    await expect(
      registerSupply(ctxB, {
        capabilityId: capA.id,
        supplier: { kind: 'employee', label: 'Beta Dana' },
        actor: ACTOR,
      }),
    ).rejects.toMatchObject({ code: 'capability_not_found' });
    await expect(
      registerRequirement(ctxB, {
        capabilityId: capA.id,
        source: { kind: 'goal', label: 'Beta goal' },
        actor: ACTOR,
      }),
    ).rejects.toMatchObject({ code: 'capability_not_found' });

    // A's capability is unchanged after B's probes.
    const still = await getCapability(ctxA, capA.id);
    expect(still.description).toBeNull();
    const stillSupply = await getSupply(ctxA, supplyA.id);
    expect(stillSupply.level).toBe(0.4);
  });
});

// ---------------------------------------------------------------------------
// Row-partition integrity over the whole migrated schema
// ---------------------------------------------------------------------------

describe('W044 repository boundary — row partition integrity', () => {
  it('stores every row of every tenant-scoped table under a sweep tenant only', async () => {
    await assertTenantPartition([tenantA, tenantB, tenantC]);
  });
});
