// W044 — Tenant Isolation Verification · application-boundary sweep for the
// cognition-layer modules: missions (W011), knowledge-acquisition (W012),
// cognition (W013), processes (W016), capabilities (W017), opportunities
// (W015), automation (W018), workforce (W019) and suppliers (W020).
//
// Same doctrine as the other sweeps: two tenants, contracts driven for both,
// cross-tenant reads/writes uniform not-found (ADR-0001), listings disjoint,
// per-tenant natural keys (mission titles, process names, capability names,
// automation opportunity names, supplier names, workforce role keys,
// idempotency keys), and — the deep part of this layer — evidence-bearing
// reconstructions, acquisition plans, signal conversions and workforce
// assessments may never draw on another tenant's events, observations or
// missions. Cross-module imports go through contracts only.

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
import {
  getMeasurement,
  getOpportunity as getAutomationOpportunity,
  getOpportunityVersion as getAutomationOpportunityVersion,
  listMeasurements,
  listOpportunities as listAutomationOpportunities,
  listOpportunityVersions as listAutomationOpportunityVersions,
  recordMeasurement,
  registerOpportunity,
  reviseOpportunity as reviseAutomationOpportunity,
} from '@/modules/automation/contract';
import {
  convertSignals,
  getConversionCandidate,
  getConversionRun,
  getOpportunity,
  getOpportunityVersion,
  listConversionRuns,
  listOpportunities,
  listOpportunityVersions,
  reviseOpportunity as reviseEngineOpportunity,
} from '@/modules/opportunities/contract';
import {
  getScorecard,
  getScorecardVersion,
  getSupplier,
  getSupplierIntelligence,
  getSupplierVersion,
  listScorecardVersions,
  listSupplierVersions,
  listSuppliers,
  rankSuppliers,
  recordScorecard,
  registerSupplier,
  reviseScorecard,
  reviseSupplier,
} from '@/modules/suppliers/contract';
import {
  assessWorkforce,
  assignRole,
  getAssignment,
  getAssignmentVersion,
  getAssessment,
  getAssessmentVersion,
  getDecision,
  getRole,
  getRoleVersion,
  getSignal,
  listAssignments,
  listAssessmentVersions,
  listAssessments,
  listDecisions,
  listRoleVersions,
  listRoles,
  listSignals,
  recordDecision,
  recordSignal,
  registerRole,
  reviseAssignment,
  reviseRole,
} from '@/modules/workforce/contract';
import {
  assertTenantPartition,
  expectUniformNotFound,
  member,
  memberWith,
  OMNIPOTENT_AUTHORITY,
  omnipotent,
  runMigrations,
} from './harness';

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
// automation (W018)
// ---------------------------------------------------------------------------

describe('W044 automation — automation opportunities are tenant-scoped', () => {
  const ACTOR = { kind: 'person' as const, id: PERSON_1, label: 'Ops lead' };
  const FLOW = [
    { type: 'invoice.registered', occurredAt: '2026-09-14T08:00:00Z' },
    { type: 'invoice.reviewed', occurredAt: '2026-09-14T08:10:00Z' },
    { type: 'invoice.approved', occurredAt: '2026-09-14T08:20:00Z' },
  ];
  const EVENT_TYPES = FLOW.map((step) => step.type);

  // The processes module's evidence chain (events → reconstruction →
  // findings), driven through contracts only — a candidate is evidence-backed.
  async function seedEvidenceProcess(ctx: TenantContext, name: string) {
    const correlationId = newId();
    for (const step of FLOW) {
      await appendEvent(ctx, {
        type: step.type,
        payload: { note: name },
        occurredAt: step.occurredAt,
        actor: { kind: 'person', id: PERSON_1 },
        source: { kind: 'system', label: 'test-harness' },
        correlationId,
      });
    }
    const process = await reconstructProcess(ctx, {
      name,
      scope: { eventTypes: EVENT_TYPES },
      actor: ACTOR,
      rationale: 'W044 fixture',
    });
    const findings = await listProcessFindings(ctx, { processId: process.id, limit: 500 });
    expect(findings.length).toBeGreaterThan(0);
    return { processId: process.id, findingId: findings[0]!.id };
  }

  function registrationInput(
    processId: string,
    findingIds: string[],
    overrides: Record<string, unknown> = {},
  ) {
    return {
      name: 'Invoice triage automation',
      processId,
      findingIds,
      frequencyCount: 600,
      period: 'month' as const,
      currency: 'EUR',
      currentCostMinor: 900_000,
      errorRate: 0.08,
      solutionTypes: ['recruit_agent' as const],
      expectedSavingsMinor: 600_000,
      expectedInvestmentMinor: 240_000,
      roiHorizonPeriods: 12,
      outcome: {
        metricName: 'manual handling minutes per month',
        metricUnit: 'minutes',
        direction: 'at_most' as const,
        baseline: 1200,
        target: 240,
      },
      actor: ACTOR,
      ...overrides,
    };
  }

  it('gives the same opportunity name independent rows per tenant', async () => {
    const alpha = await seedEvidenceProcess(ctxA, 'Automation evidence flow');
    const beta = await seedEvidenceProcess(ctxB, 'Automation evidence flow');
    const opportunityA = await registerOpportunity(
      ctxA,
      registrationInput(alpha.processId, [alpha.findingId]),
    );
    const opportunityB = await registerOpportunity(
      ctxB,
      registrationInput(beta.processId, [beta.findingId]),
    );
    expect(opportunityA.id).not.toBe(opportunityB.id);
    expect(opportunityA.tenantId).toBe(tenantA);
    expect(opportunityB.tenantId).toBe(tenantB);
    // The same name resolves to each tenant's OWN row only.
    const nameQuery = { name: 'Invoice triage automation' };
    expect((await listAutomationOpportunities(ctxA, nameQuery)).map((o) => o.id)).toEqual([
      opportunityA.id,
    ]);
    expect((await listAutomationOpportunities(ctxB, nameQuery)).map((o) => o.id)).toEqual([
      opportunityB.id,
    ]);
    expect((await listAutomationOpportunities(ctxB, {})).map((o) => o.id)).not.toContain(
      opportunityA.id,
    );
  });

  it('fails cross-tenant reads of opportunities, versions and measurements uniformly', async () => {
    const alpha = await seedEvidenceProcess(ctxA, 'Automation evidence read flow');
    const opportunityA = await registerOpportunity(
      ctxA,
      registrationInput(alpha.processId, [alpha.findingId], {
        name: 'Invoice read guard automation',
      }),
    );
    await reviseAutomationOpportunity(ctxA, {
      opportunityId: opportunityA.id,
      status: 'accepted',
      actor: ACTOR,
      rationale: 'W044 fixture',
    });
    const measurementA = await recordMeasurement(ctxA, {
      opportunityId: opportunityA.id,
      value: 300,
      actor: ACTOR,
    });

    await expectUniformNotFound(
      'opportunity_not_found',
      () => getAutomationOpportunity(ctxB, { opportunityId: opportunityA.id }),
      () => getAutomationOpportunity(ctxB, { opportunityId: newId() }),
    );
    await expectUniformNotFound(
      'opportunity_version_not_found',
      () => getAutomationOpportunityVersion(ctxB, { opportunityId: opportunityA.id, version: 1 }),
      () => getAutomationOpportunityVersion(ctxB, { opportunityId: newId(), version: 1 }),
    );
    await expect(
      listAutomationOpportunityVersions(ctxB, { opportunityId: opportunityA.id }),
    ).rejects.toMatchObject({ code: 'opportunity_not_found' });
    await expectUniformNotFound(
      'measurement_not_found',
      () => getMeasurement(ctxB, { measurementId: measurementA.id }),
      () => getMeasurement(ctxB, { measurementId: newId() }),
    );
    await expect(
      listMeasurements(ctxB, { opportunityId: opportunityA.id }),
    ).rejects.toMatchObject({ code: 'opportunity_not_found' });

    // The omnipotent principal of B is equally blind.
    await expect(
      getAutomationOpportunity(omnipotent(tenantB), { opportunityId: opportunityA.id }),
    ).rejects.toMatchObject({ code: 'opportunity_not_found' });

    // A's record is still healthy after B's probes.
    const still = await getAutomationOpportunity(ctxA, { opportunityId: opportunityA.id });
    expect(still.status).toBe('accepted');
    expect(still.outcomeMeasurements.measurementCount).toBe(1);
  });

  it('rejects cross-tenant writes before any mutation', async () => {
    const alpha = await seedEvidenceProcess(ctxA, 'Automation evidence write flow');
    const opportunityA = await registerOpportunity(
      ctxA,
      registrationInput(alpha.processId, [alpha.findingId], {
        name: 'Invoice write guard automation',
      }),
    );
    await reviseAutomationOpportunity(ctxA, {
      opportunityId: opportunityA.id,
      status: 'accepted',
      actor: ACTOR,
    });
    await recordMeasurement(ctxA, { opportunityId: opportunityA.id, value: 300, actor: ACTOR });

    await expect(
      reviseAutomationOpportunity(ctxB, {
        opportunityId: opportunityA.id,
        description: 'Pwned by B',
        actor: ACTOR,
      }),
    ).rejects.toMatchObject({ code: 'opportunity_not_found' });
    await expect(
      recordMeasurement(ctxB, { opportunityId: opportunityA.id, value: 999, actor: ACTOR }),
    ).rejects.toMatchObject({ code: 'opportunity_not_found' });

    // A's record is unchanged after B's probes.
    const still = await getAutomationOpportunity(ctxA, { opportunityId: opportunityA.id });
    expect(still.description).toBeNull();
    expect(still.version).toBe(2); // created + accepted — no phantom revision
    expect(still.outcomeMeasurements.measurementCount).toBe(1); // no phantom measurement
  });

  it('rejects candidates citing another tenant process, findings or capability', async () => {
    const alpha = await seedEvidenceProcess(ctxA, 'Automation evidence ref flow');
    const beta = await seedEvidenceProcess(ctxB, 'Automation evidence ref flow');
    const capabilityA = await registerCapability(ctxA, {
      name: `Invoice automation readiness ${newId().slice(0, 6)}`,
      actor: ACTOR,
    });

    // B cannot register a candidate over A's process evidence — a foreign
    // process (or finding) reads the same as a missing one.
    await expectUniformNotFound(
      'invalid_process_ref',
      () =>
        registerOpportunity(
          ctxB,
          registrationInput(alpha.processId, [alpha.findingId], {
            name: `Beta foreign process ${newId().slice(0, 6)}`,
          }),
        ),
      () =>
        registerOpportunity(
          ctxB,
          registrationInput(newId(), [newId()], {
            name: `Beta missing process ${newId().slice(0, 6)}`,
          }),
        ),
    );
    // B cannot name A's capability as the gap its option would close.
    await expect(
      registerOpportunity(
        ctxB,
        registrationInput(beta.processId, [beta.findingId], {
          name: `Beta foreign capability ${newId().slice(0, 6)}`,
          capabilityId: capabilityA.id,
        }),
      ),
    ).rejects.toMatchObject({ code: 'invalid_capability_ref' });
  });
});

// ---------------------------------------------------------------------------
// opportunities (W015)
// ---------------------------------------------------------------------------

describe('W044 opportunities — the conversion engine is tenant-scoped', () => {
  // The module has NO tenant-unique natural key (titles repeat; the evidence
  // fingerprint is the duplicate-detection key and is per-tenant by
  // construction, being built from this tenant's observation/claim ids) —
  // the namespace probe below proves the same business signal content
  // converts into independent records, one per tenant.

  async function seedSignal(ctx: TenantContext, note: string) {
    const observation = await recordObservation(ctx, {
      kind: 'market.signal',
      payload: { note },
      observedAt: T0,
      source: { kind: 'source', label: 'test-harness' },
      channel: 'ingestion',
      confidence: { value: 0.8, method: 'source_trust' },
    });
    return observation;
  }

  function signalCandidate(observationId: string, overrides: Record<string, unknown> = {}) {
    return {
      title: 'Expand document processing into DACH',
      description: 'External signals show unserved demand for German-language document processing.',
      signalOrigin: 'external' as const,
      evidence: { observationIds: [observationId], claimIds: [] },
      estimatedValue: { amount: 250_000_00, currency: 'EUR' },
      affectedGoals: [],
      requiredCapabilities: [],
      worldEntities: [],
      recommendedNextAction: {
        kind: 'recommend' as const,
        statement: 'Put the DACH expansion on the board agenda.',
      },
      ...overrides,
    };
  }

  function conversionRun(candidates: ReturnType<typeof signalCandidate>[]) {
    return {
      trigger: { kind: 'manual' as const },
      policy: { minConfidence: 0.5 },
      candidates,
      actor: { kind: 'system' as const, label: 'aurum-cognition' },
      rationale: 'W044 fixture',
    };
  }

  it('gives the same signal-derived opportunity independent records per tenant', async () => {
    const observationA = await seedSignal(ctxA, 'DACH demand signal');
    const observationB = await seedSignal(ctxB, 'DACH demand signal'); // same business signal
    const runA = await convertSignals(ctxA, conversionRun([signalCandidate(observationA.id)]));
    const runB = await convertSignals(ctxB, conversionRun([signalCandidate(observationB.id)]));
    const opportunityA = await getOpportunity(ctxA, runA.candidates[0]!.createdOpportunityId!);
    const opportunityB = await getOpportunity(ctxB, runB.candidates[0]!.createdOpportunityId!);
    expect(opportunityA.id).not.toBe(opportunityB.id);
    expect(opportunityA.tenantId).toBe(tenantA);
    expect(opportunityB.tenantId).toBe(tenantB);
    expect((await listOpportunities(ctxB, {})).map((o) => o.id)).not.toContain(opportunityA.id);
    expect((await listOpportunities(ctxA, {})).map((o) => o.id)).not.toContain(opportunityB.id);

    // The duplicate-detection namespace is per tenant: B's re-conversion of
    // its own signal set revises B's record — A's live opportunity never
    // blocks it and never becomes the duplicate target.
    const rerunB = await convertSignals(ctxB, conversionRun([signalCandidate(observationB.id)]));
    expect(rerunB.counts.duplicate).toBe(1);
    expect(rerunB.candidates[0]!.existingOpportunityId).toBe(opportunityB.id);
  });

  it('fails cross-tenant reads of opportunities, versions, runs and candidates uniformly', async () => {
    const observationA = await seedSignal(ctxA, 'DACH read signal');
    const runA = await convertSignals(ctxA, conversionRun([signalCandidate(observationA.id)]));
    const candidateA = runA.candidates[0]!;
    const opportunityA = await getOpportunity(ctxA, candidateA.createdOpportunityId!);

    await expectUniformNotFound(
      'opportunity_not_found',
      () => getOpportunity(ctxB, opportunityA.id),
      () => getOpportunity(ctxB, newId()),
    );
    await expectUniformNotFound(
      'opportunity_version_not_found',
      () => getOpportunityVersion(ctxB, { opportunityId: opportunityA.id, version: 1 }),
      () => getOpportunityVersion(ctxB, { opportunityId: newId(), version: 1 }),
    );
    await expect(
      listOpportunityVersions(ctxB, { opportunityId: opportunityA.id }),
    ).rejects.toMatchObject({ code: 'opportunity_not_found' });
    await expectUniformNotFound(
      'run_not_found',
      () => getConversionRun(ctxB, { runId: runA.id }),
      () => getConversionRun(ctxB, { runId: newId() }),
    );
    await expectUniformNotFound(
      'candidate_not_found',
      () => getConversionCandidate(ctxB, { candidateId: candidateA.id }),
      () => getConversionCandidate(ctxB, { candidateId: newId() }),
    );
    expect((await listConversionRuns(ctxB, {})).map((run) => run.id)).not.toContain(runA.id);

    // The omnipotent principal of B is equally blind.
    await expect(getOpportunity(omnipotent(tenantB), opportunityA.id)).rejects.toMatchObject({
      code: 'opportunity_not_found',
    });
  });

  it('rejects cross-tenant revisions before any mutation', async () => {
    const observationA = await seedSignal(ctxA, 'DACH write signal');
    const runA = await convertSignals(ctxA, conversionRun([signalCandidate(observationA.id)]));
    const opportunityA = await getOpportunity(ctxA, runA.candidates[0]!.createdOpportunityId!);

    await expect(
      reviseEngineOpportunity(ctxB, {
        opportunityId: opportunityA.id,
        title: 'Pwned by B',
        actor: { kind: 'system', label: 'beta-cognition' },
      }),
    ).rejects.toMatchObject({ code: 'opportunity_not_found' });

    // A's record is unchanged after B's probe.
    const still = await getOpportunity(ctxA, opportunityA.id);
    expect(still.version).toBe(1);
    expect(still.content.title).toBe('Expand document processing into DACH');
    expect(still.content.status).toBe('open');
  });

  it('rejects conversions citing another tenant observations (uniformly, no leak)', async () => {
    const observationA = await seedSignal(ctxA, 'DACH secret signal');
    const observationB = await seedSignal(ctxB, 'DACH base signal');

    // B's conversion citing A's observation reads the same as a missing one.
    await expectUniformNotFound(
      'invalid_evidence_ref',
      () => convertSignals(ctxB, conversionRun([signalCandidate(observationA.id)])),
      () => convertSignals(ctxB, conversionRun([signalCandidate(newId())])),
    );
    // Control: B's own evidence still converts.
    const runB = await convertSignals(ctxB, conversionRun([signalCandidate(observationB.id)]));
    expect(runB.counts.converted).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// suppliers (W020)
// ---------------------------------------------------------------------------

describe('W044 suppliers — the supplier registry and its scorecards are tenant-scoped', () => {
  const ACTOR = { kind: 'person' as const, id: PERSON_1, label: 'Procurement lead' };

  it('gives the same supplier name independent rows per tenant', async () => {
    const supplierA = await registerSupplier(ctxA, {
      name: 'Nordwind Logistics',
      kind: 'supplier',
      actor: ACTOR,
    });
    const supplierB = await registerSupplier(ctxB, {
      name: 'Nordwind Logistics',
      kind: 'supplier',
      actor: ACTOR,
    });
    expect(supplierA.id).not.toBe(supplierB.id);
    expect(supplierA.tenantId).toBe(tenantA);
    expect(supplierB.tenantId).toBe(tenantB);
    // The same name resolves to each tenant's OWN row only.
    expect((await listSuppliers(ctxA, { name: 'Nordwind Logistics' })).map((s) => s.id)).toEqual([
      supplierA.id,
    ]);
    expect((await listSuppliers(ctxB, { name: 'Nordwind Logistics' })).map((s) => s.id)).toEqual([
      supplierB.id,
    ]);
    expect((await listSuppliers(ctxB, {})).map((s) => s.id)).not.toContain(supplierA.id);
  });

  it('fails cross-tenant reads of suppliers, scorecards and their versions uniformly', async () => {
    const supplierA = await registerSupplier(ctxA, {
      name: `Birgo Freight ${newId().slice(0, 6)}`,
      kind: 'supplier',
      actor: ACTOR,
    });
    const scorecardA = await recordScorecard(ctxA, {
      supplierId: supplierA.id,
      scores: { price: 0.7, quality: 0.8 },
      actor: ACTOR,
    });

    await expectUniformNotFound(
      'supplier_not_found',
      () => getSupplier(ctxB, supplierA.id),
      () => getSupplier(ctxB, newId()),
    );
    await expectUniformNotFound(
      'supplier_version_not_found',
      () => getSupplierVersion(ctxB, { supplierId: supplierA.id, version: 1 }),
      () => getSupplierVersion(ctxB, { supplierId: newId(), version: 1 }),
    );
    await expect(
      listSupplierVersions(ctxB, { supplierId: supplierA.id }),
    ).rejects.toMatchObject({ code: 'supplier_not_found' });
    await expectUniformNotFound(
      'scorecard_not_found',
      () => getScorecard(ctxB, scorecardA.id),
      () => getScorecard(ctxB, newId()),
    );
    await expectUniformNotFound(
      'scorecard_version_not_found',
      () => getScorecardVersion(ctxB, { scorecardId: scorecardA.id, version: 1 }),
      () => getScorecardVersion(ctxB, { scorecardId: newId(), version: 1 }),
    );
    await expect(
      listScorecardVersions(ctxB, { scorecardId: scorecardA.id }),
    ).rejects.toMatchObject({ code: 'scorecard_not_found' });
    // The derived surfaces are tenant-scoped too.
    await expect(
      getSupplierIntelligence(ctxB, { supplierId: supplierA.id }),
    ).rejects.toMatchObject({ code: 'supplier_not_found' });
    expect((await rankSuppliers(ctxB, {})).map((entry) => entry.supplier.id)).not.toContain(
      supplierA.id,
    );

    // The omnipotent principal of B is equally blind.
    await expect(getSupplier(omnipotent(tenantB), supplierA.id)).rejects.toMatchObject({
      code: 'supplier_not_found',
    });
  });

  it('rejects cross-tenant registry and scorecard writes before any mutation', async () => {
    const supplierA = await registerSupplier(ctxA, {
      name: `Craftworks ${newId().slice(0, 6)}`,
      kind: 'subcontractor',
      actor: ACTOR,
    });
    const scorecardA = await recordScorecard(ctxA, {
      supplierId: supplierA.id,
      scores: { price: 0.6, reliability: 0.9 },
      actor: ACTOR,
    });

    await expect(
      reviseSupplier(ctxB, { supplierId: supplierA.id, description: 'Pwned by B', actor: ACTOR }),
    ).rejects.toMatchObject({ code: 'supplier_not_found' });
    await expect(
      recordScorecard(ctxB, { supplierId: supplierA.id, scores: { quality: 0.1 }, actor: ACTOR }),
    ).rejects.toMatchObject({ code: 'supplier_not_found' });
    await expect(
      reviseScorecard(ctxB, { scorecardId: scorecardA.id, scores: { price: 0.1 }, actor: ACTOR }),
    ).rejects.toMatchObject({ code: 'scorecard_not_found' });

    // A's records are unchanged after B's probes.
    const stillSupplier = await getSupplier(ctxA, supplierA.id);
    expect(stillSupplier.version).toBe(1);
    expect(stillSupplier.description).toBeNull();
    const stillScorecard = await getScorecard(ctxA, scorecardA.id);
    expect(stillScorecard.version).toBe(1); // no phantom assessment landed
    expect(stillScorecard.scores.price).toBe(0.6);
  });

  it('grounds supplier intelligence in the tenant own capability graph only', async () => {
    // Same-name suppliers in both tenants; only A's party supplies the
    // freight capability. The intelligence view's supplier linkage (party id
    // OR party label) reads the capability graph through the capabilities
    // CONTRACT — which is tenant-scoped — so B's view of its same-named
    // supplier resolves nothing of A's.
    const supplierA = await registerSupplier(ctxA, {
      name: 'Durable Parts',
      kind: 'supplier',
      actor: ACTOR,
    });
    const supplierB = await registerSupplier(ctxB, {
      name: 'Durable Parts',
      kind: 'supplier',
      actor: ACTOR,
    });
    const freightA = await registerCapability(ctxA, {
      name: `Freight forwarding ${newId().slice(0, 6)}`,
      actor: ACTOR,
    });
    await registerSupply(ctxA, {
      capabilityId: freightA.id,
      supplier: { kind: 'supplier', id: supplierA.id, label: 'Durable Parts' },
      level: 0.9,
      capacity: 100,
      actor: ACTOR,
    });

    const intelligenceB = await getSupplierIntelligence(ctxB, { supplierId: supplierB.id });
    expect(intelligenceB.suppliedCapabilities).toEqual([]);
    expect(intelligenceB.alternatives).toEqual([]);

    const intelligenceA = await getSupplierIntelligence(ctxA, { supplierId: supplierA.id });
    expect(
      intelligenceA.suppliedCapabilities.map((supplied) => supplied.capability.id),
    ).toContain(freightA.id);
  });
});

// ---------------------------------------------------------------------------
// workforce (W019)
// ---------------------------------------------------------------------------

describe('W044 workforce — workforce intelligence is tenant-scoped', () => {
  const ACTOR = { kind: 'person' as const, id: PERSON_1, label: 'Ops lead' };
  // The same opaque people-module employee ids exist in BOTH tenants (the
  // people records themselves are per-tenant realities of each tenant).
  const EMPLOYEE_ADA = '00000000-0000-4000-8000-0000000000a1';
  const EMPLOYEE_BOB = '00000000-0000-4000-8000-0000000000a2';
  const EMPLOYEE_CAROL = '00000000-0000-4000-8000-0000000000a3';

  it('gives the same role key and employee independent records per tenant', async () => {
    const roleA = await registerRole(ctxA, {
      roleKey: 'Support engineer',
      title: 'Alpha support desk',
      expectedWeeklyHours: 40,
      actor: ACTOR,
    });
    const roleB = await registerRole(ctxB, {
      roleKey: 'Support engineer',
      title: 'Beta support desk',
      expectedWeeklyHours: 40,
      actor: ACTOR,
    });
    expect(roleA.id).not.toBe(roleB.id);
    expect(roleA.tenantId).toBe(tenantA);
    expect(roleB.tenantId).toBe(tenantB);

    // The same employee id holds the same role key in both tenants —
    // independent (role, employee) graph keys.
    const assignmentA = await assignRole(ctxA, {
      roleId: roleA.id,
      employee: { id: EMPLOYEE_ADA, label: 'Ada' },
      allocation: 0.75,
      actor: ACTOR,
    });
    const assignmentB = await assignRole(ctxB, {
      roleId: roleB.id,
      employee: { id: EMPLOYEE_ADA, label: 'Ada' },
      allocation: 0.75,
      actor: ACTOR,
    });
    expect(assignmentA.id).not.toBe(assignmentB.id);

    expect((await listRoles(ctxB, {})).map((role) => role.id)).not.toContain(roleA.id);
    expect(
      (await listAssignments(ctxB, { employeeId: EMPLOYEE_ADA })).map((a) => a.id),
    ).not.toContain(assignmentA.id);
    expect(
      (await listAssignments(ctxA, { employeeId: EMPLOYEE_ADA })).map((a) => a.id),
    ).toContain(assignmentA.id);
  });

  it('fails cross-tenant reads of roles, assignments, signals, assessments and decisions uniformly', async () => {
    const roleA = await registerRole(ctxA, {
      roleKey: 'Reactive on-call',
      expectedWeeklyHours: 40,
      actor: ACTOR,
    });
    const assignmentA = await assignRole(ctxA, {
      roleId: roleA.id,
      employee: { id: EMPLOYEE_ADA },
      actor: ACTOR,
    });
    const signalA = await recordSignal(ctxA, {
      employee: { id: EMPLOYEE_ADA },
      kind: 'workload',
      value: 42,
      actor: ACTOR,
    });
    const assessmentA = await assessWorkforce(ctxA, {
      employee: { id: EMPLOYEE_ADA },
      recommendation: { kind: 'monitor', text: 'Watch the on-call load.' },
      confidence: 0.6,
      actor: ACTOR,
    });
    const decisionA = await recordDecision(memberWith(tenantA, ['workforce:decide']), {
      assessmentId: assessmentA.id,
      decision: 'accepted',
      decider: { kind: 'person', id: PERSON_1 },
    });

    await expectUniformNotFound(
      'role_not_found',
      () => getRole(ctxB, roleA.id),
      () => getRole(ctxB, newId()),
    );
    await expectUniformNotFound(
      'role_version_not_found',
      () => getRoleVersion(ctxB, { roleId: roleA.id, version: 1 }),
      () => getRoleVersion(ctxB, { roleId: newId(), version: 1 }),
    );
    await expect(listRoleVersions(ctxB, { roleId: roleA.id })).rejects.toMatchObject({
      code: 'role_not_found',
    });
    await expectUniformNotFound(
      'assignment_not_found',
      () => getAssignment(ctxB, assignmentA.id),
      () => getAssignment(ctxB, newId()),
    );
    await expectUniformNotFound(
      'assignment_version_not_found',
      () => getAssignmentVersion(ctxB, { assignmentId: assignmentA.id, version: 1 }),
      () => getAssignmentVersion(ctxB, { assignmentId: newId(), version: 1 }),
    );
    await expectUniformNotFound(
      'signal_not_found',
      () => getSignal(ctxB, { signalId: signalA.id }),
      () => getSignal(ctxB, { signalId: newId() }),
    );
    await expectUniformNotFound(
      'assessment_not_found',
      () => getAssessment(ctxB, assessmentA.id),
      () => getAssessment(ctxB, newId()),
    );
    await expectUniformNotFound(
      'assessment_version_not_found',
      () => getAssessmentVersion(ctxB, { assessmentId: assessmentA.id, version: 1 }),
      () => getAssessmentVersion(ctxB, { assessmentId: newId(), version: 1 }),
    );
    await expect(
      listAssessmentVersions(ctxB, { assessmentId: assessmentA.id }),
    ).rejects.toMatchObject({ code: 'assessment_not_found' });
    await expectUniformNotFound(
      'decision_not_found',
      () => getDecision(ctxB, { decisionId: decisionA.id }),
      () => getDecision(ctxB, { decisionId: newId() }),
    );
    // Listings stay per-tenant.
    expect((await listSignals(ctxB, { employeeId: EMPLOYEE_ADA })).map((s) => s.id)).not.toContain(
      signalA.id,
    );
    expect((await listAssessments(ctxB, {})).map((a) => a.id)).not.toContain(assessmentA.id);
    expect(await listDecisions(ctxB, {})).toEqual([]);

    // The omnipotent principal of B — every repository claim plus this
    // module's own 'workforce:decide' — is STILL blind to A's assessment.
    await expect(
      getAssessment(
        memberWith(tenantB, [...OMNIPOTENT_AUTHORITY, 'workforce:decide']),
        assessmentA.id,
      ),
    ).rejects.toMatchObject({ code: 'assessment_not_found' });
  });

  it('rejects cross-tenant writes before any mutation (claims never bypass scope)', async () => {
    const roleA = await registerRole(ctxA, {
      roleKey: 'Signal desk',
      title: 'Alpha signal desk',
      expectedWeeklyHours: 30,
      actor: ACTOR,
    });
    const assignmentA = await assignRole(ctxA, {
      roleId: roleA.id,
      employee: { id: EMPLOYEE_BOB },
      allocation: 0.5,
      actor: ACTOR,
    });
    const assessmentA = await assessWorkforce(ctxA, {
      employee: { id: EMPLOYEE_BOB },
      recommendation: { kind: 'monitor', text: 'Baseline assessment before any decision.' },
      confidence: 0.6,
      actor: ACTOR,
    });
    const blindB = memberWith(tenantB, [...OMNIPOTENT_AUTHORITY, 'workforce:decide']);

    await expect(
      reviseRole(ctxB, { roleId: roleA.id, title: 'Pwned by B', actor: ACTOR }),
    ).rejects.toMatchObject({ code: 'role_not_found' });
    await expect(
      assignRole(ctxB, { roleId: roleA.id, employee: { id: EMPLOYEE_BOB }, actor: ACTOR }),
    ).rejects.toMatchObject({ code: 'role_not_found' });
    await expect(
      reviseAssignment(ctxB, { assignmentId: assignmentA.id, allocation: 1, actor: ACTOR }),
    ).rejects.toMatchObject({ code: 'assignment_not_found' });
    // Holding every claim the repository checks — 'workforce:decide'
    // included — the principal of B STILL cannot decide A's assessment.
    await expect(
      recordDecision(blindB, {
        assessmentId: assessmentA.id,
        decision: 'rejected',
        decider: { kind: 'person', id: PERSON_1 },
      }),
    ).rejects.toMatchObject({ code: 'assessment_not_found' });

    // A's records are unchanged after B's probes.
    const stillRole = await getRole(ctxA, roleA.id);
    expect(stillRole.version).toBe(1);
    expect(stillRole.title).toBe('Alpha signal desk');
    const stillAssignment = await getAssignment(ctxA, assignmentA.id);
    expect(stillAssignment.allocation).toBe(0.5);
    const stillAssessment = await getAssessment(ctxA, assessmentA.id);
    expect(stillAssessment.decision).toBeNull(); // no phantom decision landed
    // A's own human decision still lands — first-decision-wins proves B's
    // probe never persisted anything on A's assessment version.
    const decisionA = await recordDecision(memberWith(tenantA, ['workforce:decide']), {
      assessmentId: assessmentA.id,
      decision: 'accepted',
      decider: { kind: 'person', id: PERSON_1 },
    });
    expect(decisionA.tenantId).toBe(tenantA);
  });

  it('draws assessments on in-tenant signals only (same employee id in both tenants)', async () => {
    // The same employee id is measured in both tenants; each tenant's
    // signals are its own — a workload reading of one tenant never enters
    // the other tenant's assessment of the "same" person.
    await recordSignal(ctxA, {
      employee: { id: EMPLOYEE_CAROL, label: 'Carol' },
      kind: 'workload',
      value: 40,
      actor: ACTOR,
    });
    await recordSignal(ctxB, {
      employee: { id: EMPLOYEE_CAROL, label: 'Carol' },
      kind: 'workload',
      value: 80,
      actor: ACTOR,
    });

    const assessmentA = await assessWorkforce(ctxA, {
      employee: { id: EMPLOYEE_CAROL, label: 'Carol' },
      recommendation: { kind: 'monitor', text: 'Alpha-side load reading.' },
      confidence: 0.6,
      actor: ACTOR,
    });
    const assessmentB = await assessWorkforce(ctxB, {
      employee: { id: EMPLOYEE_CAROL, label: 'Carol' },
      recommendation: { kind: 'monitor', text: 'Beta-side load reading.' },
      confidence: 0.6,
      actor: ACTOR,
    });
    // Each assessment saw only its own tenant's signal.
    expect(assessmentA.content.workload.observedWeeklyHours).toBe(40);
    expect(assessmentA.content.workload.workloadSignalCount).toBe(1);
    expect(assessmentB.content.workload.observedWeeklyHours).toBe(80);
    expect(assessmentB.content.workload.workloadSignalCount).toBe(1);
    // Separate per-employee assessment identities per tenant.
    expect(assessmentA.id).not.toBe(assessmentB.id);
    expect(assessmentA.tenantId).toBe(tenantA);
    expect(assessmentB.tenantId).toBe(tenantB);
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
