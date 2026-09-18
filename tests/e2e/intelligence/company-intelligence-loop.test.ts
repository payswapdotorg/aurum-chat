// ============================================================================
// W049 — Company Intelligence End-to-End Fixture
// ============================================================================
//
// Work item (spec/work-items/WORK-ITEM-CATALOG.md, verbatim):
//
//   "Prove: observation → goal relevance → unknown → learning mission →
//    employee/system/external acquisition → belief update →
//    opportunity/inefficiency → recommendation → approved capability
//    change → measured outcome."
//
// IMPLEMENTATION-STACK §7 places this fixture here: "Cross-cutting fixtures
// live in tests/ at repo root (tenant isolation sweeps W044, end-to-end
// W049/W050, longitudinal benchmark W056)."
//
// THE SCENARIO (one synthetic company, one full turn of the frozen §2 loop):
//
//   Northwind Fixture Co processes supplier invoices in its ERP. The AP
//   clerk re-keys every invoice twice before validation; the CFO has a
//   board-mandated goal to cut invoice processing cost. Aurum observes the
//   clerk's report and an ERP backlog symptom, reconstructs the actual AP
//   process from the ERP event stream, finds the goal-relevant knowledge
//   gap ("which steps can be automated without breaking controls?"),
//   launches a learning mission, asks the AP clerk (employee acquisition),
//   pulls the ERP's own Q3 report (system acquisition) and an external AP
//   automation benchmark (external acquisition), updates its working
//   belief from the three evidence-backed answers, detects the process
//   inefficiency (bottleneck + duplication + manual effort) and the
//   uncovered automation capability, RECOMMENDS an EXECUTE-level
//   capability change, waits for the human approval the authority matrix
//   demands, executes the approved change through the capability graph,
//   and measures the outcome against the goal's own threshold.
//
// Every arrow of the chain is proven against REAL module state through
// PUBLIC CONTRACTS ONLY (each import below is `@/modules/<m>/contract`,
// `@/infra/*` or the migration runner — the fixture owns no module code).
//
// Mapping of the chain onto the delivered modules at base 8f2096a:
//
//   observation                     → observations (W004) + cognition stage 1
//   goal relevance                  → goals (W008) + cognition stage 5
//   unknown                         → epistemics (W007) + cognition stage 6
//   learning mission                → missions (W011) + cognition stage 6
//   employee/system/external
//   acquisition                     → knowledge-acquisition (W012): the
//                                     employee leg is orchestrated by
//                                     cognition stage 7 (planner + targeted
//                                     question + ASK policy gate + suspend/
//                                     resume); the system and external legs
//                                     drive the same planner directly —
//                                     exactly the "caller's job" the W012
//                                     contract documents for confidence
//                                     updates (W013 cognition orchestrates;
//                                     this fixture is the loop driver for
//                                     the two acquisitions a single
//                                     canonical cycle cannot suspend on).
//   belief update                   → epistemics (W007) beliefs, versioned
//                                     with per-version provenance (stage 8
//                                     forms v1 from the employee answer;
//                                     v2 weighs all three answers)
//   opportunity/inefficiency        → processes (W016) reconstructProcess
//                                     findings (bottleneck, duplication,
//                                     manual effort — each citing its exact
//                                     event/observation evidence) plus the
//                                     derived opportunity/capability-gap
//                                     findings on the cognition trace
//                                     (stage 9; the W015 opportunity module
//                                     is not delivered at this base — see
//                                     the delivery report's DEVIATIONS)
//   recommendation                  → actions (W009) + cognition stage 10:
//                                     'capability-change' at the EXECUTE
//                                     level is routed through the authority
//                                     matrix and gated on human approval
//   approved capability change      → actions decideApproval (human) +
//                                     capabilities (W017): the supply that
//                                     covers the gap is registered only
//                                     after the request is approved, and
//                                     analyzeGaps flips uncovered → covered
//   measured outcome                → learning (W040): baseline (ERP
//                                     answer) vs expected (goal threshold)
//                                     vs realized (post-change
//                                     measurement), settled with the frozen
//                                     deterministic assessment
//
// The whole spine runs inside ONE explicit, resumable cognitive execution
// (W013) whose twelve-step trace makes the chain reconstructable (§24).
// ============================================================================

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { runMigrations } from '../../../scripts/migrate';

import {
  ORGANIZATIONS_AUTHORITY_PROVISION,
  provisionTenant,
} from '@/modules/organizations/contract';
import {
  IDENTITY_AUTHORITY_ATTEST,
  IDENTITY_AUTHORITY_LINK,
  attestIdentity,
  registerExternalIdentity,
} from '@/modules/identity/contract';
import {
  createEmployee,
  createPerson,
  linkExternalIdentity,
  resolveIdentity,
} from '@/modules/people/contract';
import { createGoal, getGoal } from '@/modules/goals/contract';
import {
  recordObservation,
  getObservation,
} from '@/modules/observations/contract';
import { appendEvent } from '@/modules/events/contract';
import { recordTransactiveEntry } from '@/modules/memory/contract';
import {
  getUnknown,
  listBeliefHistory,
  resolveUnknown,
  reviseBelief,
} from '@/modules/epistemics/contract';
import {
  completeMission,
  getMission,
  reviseMission,
} from '@/modules/missions/contract';
import {
  getAcquisitionPlan,
  planNextAcquisition,
  recordAcquisitionOutcome,
} from '@/modules/knowledge-acquisition/contract';
import type {
  AcquisitionPlan,
  CandidateSignals,
} from '@/modules/knowledge-acquisition/contract';
import {
  ACTIONS_AUTHORITY_APPROVE,
  decideApproval,
  getActionRequest,
} from '@/modules/actions/contract';
import {
  getExecution,
  runNextStage,
  startExecution,
} from '@/modules/cognition/contract';
import type { CognitiveExecutionTrace } from '@/modules/cognition/contract';
import {
  analyzeGaps,
  registerCapability,
  registerRequirement,
  registerSupply,
} from '@/modules/capabilities/contract';
import {
  listProcessFindings,
  reconstructProcess,
} from '@/modules/processes/contract';
import {
  defineOutcome,
  getOutcome,
  recordMeasurement,
  settleOutcome,
} from '@/modules/learning/contract';
import { CognitionError } from '@/modules/cognition/contract';
import { LearningError } from '@/modules/learning/contract';
import { MissionsError } from '@/modules/missions/contract';
import { ProcessesError } from '@/modules/processes/contract';
import { EpistemicsError } from '@/modules/epistemics/contract';

// ---------------------------------------------------------------------------
// Principals and contexts
// ---------------------------------------------------------------------------

/** Platform bootstrapper (provisions the tenant). */
const platformPrincipal = newId();
/** The tenant owner — the finance management surface. */
const managerPrincipal = newId();
/** The system principal that drives the cognitive loop (the worker). */
const loopPrincipal = newId();
/** A human approver (separation of duties — never the requester). */
const approverPrincipal = newId();
/** The AP clerk's own principal (she records her answer herself). */
const clerkPrincipal = newId();

const platformCtx = {
  principalId: platformPrincipal,
  authority: [ORGANIZATIONS_AUTHORITY_PROVISION],
};
let managerCtx: TenantContext; // tenant owner, no special claims
let identityAdminCtx: TenantContext; // identity:attest
let identityLinkerCtx: TenantContext; // identity:link
let loopCtx: TenantContext; // the cognition worker
let approverCtx: TenantContext; // actions:approve
let clerkCtx: TenantContext; // the AP clerk

// ---------------------------------------------------------------------------
// Shared chain state (filled leg by leg; every leg asserts its handoff)
// ---------------------------------------------------------------------------

let tenantId = '';
let clerkPersonId = '';
let clerkEmployeeId = '';
let goalId = '';
let triggerObservationId = '';
let backlogObservationId = '';
let auditNoteObservationId = '';
let transactiveEntryId = '';
const processEventIds: string[] = [];
let executionId = '';
let processEntityId = '';
let claimIds: string[] = [];
let unknownId = '';
let missionId = '';
let employeePlanId = '';
let employeeAnswerObservationId = '';
let systemPlanId = '';
let systemAnswerObservationId = '';
let externalPlanId = '';
let externalAnswerObservationId = '';
let beliefId = '';
let processId = '';
let capabilityId = '';
let actionRequestId = '';
let postChangeObservationId = '';
let outcomeId = '';
let measurementId = '';

// ---------------------------------------------------------------------------
// Scenario constants
// ---------------------------------------------------------------------------

const FOCUS_TOPICS = ['invoicing', 'accounts-payable', 'automation'] as const;

/** The AP invoice cases, with controlled occurrence times (bottleneck math). */
const CASE_BASE_MS = Date.parse('2026-09-07T09:00:00Z');
/** One case per day; the case id is the events correlation id (a uuid, W003). */
const CASES = [
  { ref: 'INV-2026-1001', correlationId: newId() },
  { ref: 'INV-2026-1002', correlationId: newId() },
  { ref: 'INV-2026-1003', correlationId: newId() },
] as const;

/**
 * Per case: received(t0) → data-entry(t0+2min) → data-entry(t0+32min,
 * rework) → validated(t0+2h32min) → posted(t0+2h34min). The
 * data-entry → validated edge waits 2h across 3 instances (the
 * bottleneck); data-entry repeats within every case (duplication) and is
 * 100% person-performed (manual effort).
 */
const CASE_TIMELINE: ReadonlyArray<{ type: string; offsetMs: number; manual: boolean }> = [
  { type: 'invoice.received', offsetMs: 0, manual: false },
  { type: 'invoice.data-entry', offsetMs: 2 * 60_000, manual: true },
  { type: 'invoice.data-entry', offsetMs: 32 * 60_000, manual: true },
  { type: 'invoice.validated', offsetMs: (2 * 60 + 32) * 60_000, manual: false },
  { type: 'invoice.posted', offsetMs: (2 * 60 + 34) * 60_000, manual: false },
];

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

beforeAll(async () => {
  await runMigrations(getDb());
});

afterAll(async () => {
  await closeDb();
});

// ---------------------------------------------------------------------------
// Phase 0 — the company, its people and its goal
// ---------------------------------------------------------------------------

describe('W049 · phase 0 — the company, its people and its goal', () => {
  it('provisions the tenant through the organizations contract', async () => {
    const tenant = await provisionTenant(platformCtx, {
      name: 'Northwind Fixture Co',
      ownerPrincipalId: managerPrincipal,
      defaultWorkspaceName: 'Head Office',
    });
    tenantId = tenant.id;
    expect(tenantId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );

    managerCtx = { tenantId, principalId: managerPrincipal, authority: [] };
    identityAdminCtx = { tenantId, principalId: newId(), authority: [IDENTITY_AUTHORITY_ATTEST] };
    identityLinkerCtx = { tenantId, principalId: newId(), authority: [IDENTITY_AUTHORITY_LINK] };
    loopCtx = { tenantId, principalId: loopPrincipal, authority: [] };
    approverCtx = { tenantId, principalId: approverPrincipal, authority: [ACTIONS_AUTHORITY_APPROVE] };
    clerkCtx = { tenantId, principalId: clerkPrincipal, authority: [] };
  });

  it('creates the AP clerk (person + active employee) and verifies her channel identity', async () => {
    const person = await createPerson(managerCtx, {
      fullName: 'Maya Chen',
      email: 'maya.chen@northwind-fixture.example',
    });
    clerkPersonId = person.id;

    const employee = await createEmployee(managerCtx, {
      personId: clerkPersonId,
      employeeNumber: 'AP-014',
      title: 'Accounts Payable Specialist',
      department: 'Finance',
      hiredAt: '2023-02-01T00:00:00.000Z',
    });
    clerkEmployeeId = employee.id;
    expect(employee.status).toBe('active');

    // Verified linking (lock 15): the Slack account resolves to the employee
    // — this is what makes her an ASKABLE person candidate for W012.
    const registered = await registerExternalIdentity(identityAdminCtx, {
      provider: 'slack',
      providerAccountId: 'maya.ap',
      displayName: 'Maya Chen (AP)',
    });
    await attestIdentity(identityAdminCtx, {
      identityId: registered.identity.id,
      evidence: 'HR directory match confirmed in person by the finance manager',
    });
    await linkExternalIdentity(identityLinkerCtx, {
      personId: clerkPersonId,
      identityId: registered.identity.id,
    });

    const resolution = await resolveIdentity(managerCtx, {
      provider: 'slack',
      providerAccountId: 'maya.ap',
    });
    expect(resolution.status).toBe('resolved');
    if (resolution.status === 'resolved') {
      expect(resolution.person.id).toBe(clerkPersonId);
      expect(resolution.employee?.id).toBe(clerkEmployeeId);
      expect(resolution.employee?.status).toBe('active');
    }
  });

  it('defines the management goal the whole cycle must serve', async () => {
    const cfo = await createPerson(managerCtx, {
      fullName: 'Daniel Okafor',
      email: 'daniel.okafor@northwind-fixture.example',
    });
    const goal = await createGoal(managerCtx, {
      title: 'Cut AP invoice processing cost',
      objective: 'Reduce the fully-loaded cost of processing one supplier invoice',
      desiredState:
        'Invoice entry and validation are automated; manual touch time is at or under 10 minutes per invoice',
      metrics: [
        {
          name: 'manual-minutes-per-invoice',
          unit: 'minutes',
          direction: 'at_most',
          threshold: 10,
        },
      ],
      horizonStart: '2026-09-01T00:00:00.000Z',
      horizonEnd: '2027-06-30T00:00:00.000Z',
      owner: { kind: 'person', id: cfo.id, label: 'Daniel Okafor (CFO)' },
      priority: 'high',
      evidenceSources: [
        { kind: 'system', label: 'ERP invoice module' },
        { kind: 'person', id: clerkPersonId, label: 'Maya Chen (AP)' },
      ],
      successCriteria:
        'Manual minutes per invoice at or under 10 measured from the ERP by 2027-06-30',
      actor: { kind: 'person', id: cfo.id, label: 'Daniel Okafor (CFO)' },
      rationale: 'Board cost-reduction program',
    });
    goalId = goal.id;

    const read = await getGoal(managerCtx, goalId);
    expect(read.content.status).toBe('active');
    expect(read.version).toBe(1);
    expect(read.content.metrics[0]?.threshold).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// Leg 1 — observation
// ---------------------------------------------------------------------------

describe('W049 · leg 1 — observation (immutable evidence enters the loop)', () => {
  it('records the trigger and symptom observations with provenance and confidence', async () => {
    const trigger = await recordObservation(managerCtx, {
      kind: 'channel.message',
      payload: {
        channel: '#finance',
        text: 'AP cycle time has doubled this quarter — we re-key every invoice twice before validation',
      },
      observedAt: '2026-09-08T08:15:00.000Z',
      source: { kind: 'person', id: clerkPersonId, label: 'Maya Chen (AP)' },
      channel: 'slack',
      confidence: { value: 0.8, method: 'human-report', basis: 'first-hand operator report' },
    });
    triggerObservationId = trigger.id;

    const backlog = await recordObservation(managerCtx, {
      kind: 'metric.sample',
      payload: {
        metric: 'ap-invoice-backlog',
        value: 142,
        unit: 'invoices',
        window: '2026-W36',
      },
      observedAt: '2026-09-08T08:30:00.000Z',
      source: { kind: 'system', label: 'ERP invoice module' },
      channel: 'api',
      confidence: { value: 0.97, method: 'system-report' },
    });
    backlogObservationId = backlog.id;

    const reread = await getObservation(managerCtx, triggerObservationId);
    expect(reread.source.kind).toBe('person');
    expect(reread.confidence.value).toBe(0.8);
    expect(reread.observedAt).toBe('2026-09-08T08:15:00.000Z');
  });

  it('seeds the transactive memory that makes the clerk the known invoicing expert', async () => {
    const entry = await recordTransactiveEntry(managerCtx, {
      actor: { kind: 'person', id: clerkPersonId, label: 'Maya Chen' },
      relation: 'knows',
      subjectLabel: 'AP invoice processing steps and the ERP invoice module',
      topics: [...FOCUS_TOPICS],
      evidenceObservationIds: [triggerObservationId],
      notes: 'Maya runs AP daily and administers the ERP invoice module',
    });
    transactiveEntryId = entry.id;
    // Topics are stored + returned sorted (retrieval keys, set semantics).
    expect(entry.topics).toEqual([...FOCUS_TOPICS].sort());
  });

  it('appends the ERP event stream the process reconstruction will mine', async () => {
    for (const [caseIndex, apCase] of CASES.entries()) {
      const base = CASE_BASE_MS + caseIndex * 86_400_000; // one case per day
      for (const [stepIndex, step] of CASE_TIMELINE.entries()) {
        const event = await appendEvent(loopCtx, {
          type: step.type,
          payload: { caseRef: apCase.ref, clerk: step.manual ? 'maya.chen' : null },
          occurredAt: iso(base + step.offsetMs),
          actor: step.manual
            ? { kind: 'person', id: clerkPersonId, label: 'Maya Chen' }
            : { kind: 'system', label: 'erp' },
          source: { kind: 'system', label: 'erp' },
          correlationId: apCase.correlationId,
          idempotencyKey: `w049:${apCase.ref}:${stepIndex}`,
        });
        processEventIds.push(event.id);
      }
    }
    expect(processEventIds).toHaveLength(CASES.length * CASE_TIMELINE.length);

    // One audit-note observation grouped into a case by its payload key —
    // the observation half of the W016 evidence surface.
    const auditNote = await recordObservation(managerCtx, {
      kind: 'invoice.audit-note',
      payload: {
        // The payload case key joins the observation to the event case
        // (W016's caseKeyCandidates) — the correlation id IS the case id.
        caseId: CASES[1]!.correlationId,
        caseRef: CASES[1]!.ref,
        note: 'Third re-key of the same invoice this week — flagged in the weekly audit',
      },
      observedAt: iso(CASE_BASE_MS + 86_400_000 + (2 * 60 + 36) * 60_000),
      source: { kind: 'person', label: 'Internal Audit' },
      channel: 'audit',
      confidence: { value: 0.9, method: 'audit-review' },
    });
    auditNoteObservationId = auditNote.id;
  });
});

// ---------------------------------------------------------------------------
// The spine — one explicit, resumable cognitive execution (W013)
// ---------------------------------------------------------------------------

describe('W049 · the spine — one canonical cognitive execution', () => {
  it('starts an explicit observation-triggered execution (no stage work yet)', async () => {
    const trace = await startExecution(loopCtx, {
      trigger: { kind: 'observation', id: triggerObservationId, label: 'AP channel report' },
      focus: { topics: [...FOCUS_TOPICS], entities: [] },
      actor: { kind: 'system', label: 'aurum-cognition' },
      rationale: 'W049 fixture: one full turn of the company intelligence loop',
    });
    executionId = trace.id;
    expect(trace.state).toBe('running');
    expect(trace.completedStages).toBe(0);
    expect(trace.trigger.id).toBe(triggerObservationId);
    expect(trace.correlationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('stages 1–2 — ingests the evidence and remembers who knows what', async () => {
    const observed = await runNextStage(loopCtx, {
      executionId,
      stage: 'observation',
      reference: [triggerObservationId],
      record: [
        {
          kind: 'channel.message',
          payload: {
            channel: '#finance',
            text: 'CFO: invoice processing cost is the board cost program — get it under control',
          },
          observedAt: '2026-09-08T09:00:00.000Z',
          source: { kind: 'person', label: 'Daniel Okafor (CFO)' },
          channel: 'slack',
          confidence: { value: 0.85, method: 'human-report' },
        },
      ],
    });
    expect(observed.state).toBe('running');
    expect(observed.steps).toHaveLength(1);
    const intake = observed.steps[0]!.result as {
      stage: 'observation';
      observationIds: string[];
      recordedObservationIds: string[];
    };
    // The referenced trigger and the newly recorded CFO message — the
    // cycle's evidence set (learning-stage citations come from here).
    expect(intake.observationIds).toContain(triggerObservationId);
    expect(intake.recordedObservationIds).toHaveLength(1);

    const remembered = await runNextStage(loopCtx, {
      executionId,
      stage: 'evidence-memory',
    });
    expect(remembered.steps).toHaveLength(2); // observation + evidence-memory
    const memoryStep = remembered.steps[1]!.result as {
      stage: 'evidence-memory';
      transactiveEntryIds: string[];
    };
    // The "remember" half of §2: retrieval surfaces who knows the focus.
    expect(memoryStep.transactiveEntryIds).toContain(transactiveEntryId);
  });

  it('stage 3 — updates the world model with the AP process entity', async () => {
    const trace = await runNextStage(loopCtx, {
      executionId,
      stage: 'world-update',
      update: {
        kind: 'create-entity',
        entity: {
          kind: 'process',
          name: 'AP invoice processing',
          description: 'Supplier invoice intake, entry, validation and posting in the ERP',
          attributes: { owner: 'Finance', system: 'ERP invoice module' },
        },
      },
    });
    const update = trace.steps[2]!.result as {
      stage: 'world-update';
      update: { kind: string; entityId?: string } | null;
    };
    expect(update.update?.kind).toBe('create-entity');
    processEntityId = update.update?.entityId ?? '';
    expect(processEntityId).not.toBe('');
  });

  it('stage 4 — derives the claims the evidence supports', async () => {
    const trace = await runNextStage(loopCtx, {
      executionId,
      stage: 'epistemic-evaluation',
      claims: [
        {
          proposition: 'Every AP invoice is manually keyed at least twice before validation',
          subject: { kind: 'world.entity', id: processEntityId },
          confidence: { value: 0.82, method: 'operator-report-plus-metric' },
          evidenceObservationIds: [triggerObservationId, backlogObservationId],
          rationale: 'Clerk report consistent with the backlog sample',
        },
      ],
    });
    const claims = trace.steps[3]!.result as { stage: 'epistemic-evaluation'; claimIds: string[] };
    claimIds = claims.claimIds;
    expect(claimIds).toHaveLength(1);
  });

  it('leg 2 — goal relevance: stage 5 relates the cycle to the active goal', async () => {
    const trace = await runNextStage(loopCtx, {
      executionId,
      stage: 'goal-evaluation',
      relatedGoalIds: [goalId],
    });
    const evaluation = trace.steps[4]!.result as {
      stage: 'goal-evaluation';
      goalIds: string[];
      activeGoalCount: number;
    };
    // The observation matters BECAUSE the tenant has an active goal it
    // threatens — the loop's relevance link (§2 "evaluate goals").
    expect(evaluation.goalIds).toEqual([goalId]);
    expect(evaluation.activeGoalCount).toBeGreaterThanOrEqual(1);

    const goal = await getGoal(loopCtx, goalId);
    expect(goal.content.status).toBe('active');
    expect(goal.content.metrics[0]?.direction).toBe('at_most');
  });

  it('legs 3+4 — unknown → learning mission: stage 6 records the gap and invests in it', async () => {
    const trace = await runNextStage(loopCtx, {
      executionId,
      stage: 'unknown-mission-evaluation',
      unknowns: [
        {
          question:
            'Which AP invoice processing steps can be automated without violating approval controls?',
          consequence:
            'Without this, the invoice-cost goal cannot be planned: automation scope, risk and expected savings are unknown',
          subject: { kind: 'world.entity', id: processEntityId },
          relatedObservationIds: [triggerObservationId, backlogObservationId],
          note: 'Derived by the W049 cycle from the AP report and the backlog sample',
        },
      ],
      missions: [
        {
          title: 'Determine the automatable AP invoice steps',
          knowledgeObjective:
            'Which steps of AP invoice processing (intake, data entry, validation, posting) can be automated without violating approval controls, and what does the manual effort cost today?',
          affectedGoals: [{ goalId, label: 'Cut AP invoice processing cost' }],
          unknownIds: [],
          informationValue: 0.9,
          urgency: 'high',
          currentConfidence: 0.25,
          targetConfidence: 0.9,
          investigationBudget: { amount: 500_000, currency: 'USD' },
          rewardBudget: { amount: 100_000, currency: 'USD' },
          candidateSources: [
            { kind: 'person', id: clerkPersonId, label: 'Maya Chen' },
            { kind: 'system', label: 'ERP invoice module' },
            { kind: 'external', label: 'AP automation benchmark 2026' },
          ],
          completionCriteria:
            'Confidence at or above 0.9 on the automatable-steps question, with evidence from an employee, the ERP and an external benchmark',
          rationale: 'W049 cycle: the goal-relevant knowledge gap',
        },
      ],
    });
    const result = trace.steps[5]!.result as {
      stage: 'unknown-mission-evaluation';
      unknownIds: string[];
      missionIds: string[];
    };
    unknownId = result.unknownIds[0]!;
    missionId = result.missionIds[0]!;

    // The unknown is a first-class consequential gap (lock 7).
    const unknown = await getUnknown(loopCtx, { unknownId });
    expect(unknown.status).toBe('open');
    expect(unknown.consequence).toContain('goal');
    expect(unknown.subject?.id).toBe(processEntityId);

    // The mission is an active, budgeted learning investment whose menu
    // carries all three acquisition families (§7's planner menu).
    const mission = await getMission(loopCtx, missionId);
    expect(mission.content.status).toBe('active');
    expect(mission.content.affectedGoals.map((g) => g.goalId)).toEqual([goalId]);
    expect(mission.content.candidateSources.map((c) => c.kind)).toEqual([
      'person',
      'system',
      'external',
    ]);
  });

  it('links the unknown to the mission (the mission closes the gap)', async () => {
    const mission = await reviseMission(loopCtx, {
      missionId,
      unknownIds: [unknownId],
      actor: { kind: 'system', label: 'aurum-cognition' },
      rationale: 'link the launched mission to the unknown it exists to close',
    });
    expect(mission.content.unknownIds).toEqual([unknownId]);
  });

  it('leg 5a — employee acquisition: the planner asks the clerk a mission-derived, policy-checked question', async () => {
    // Stage 7 fresh: cognition drives the W012 planner over the mission's
    // menu. Maya's transactive-memory coverage makes her the next-best
    // source; asking an employee is an ASK-level 'employee-messaging'
    // action the authority matrix must permit.
    const suspended = await runNextStage(loopCtx, {
      executionId,
      stage: 'knowledge-acquisition',
      missionId,
    });
    expect(suspended.state).toBe('awaiting_input'); // the question is answered in the world, not in a transaction
    expect(suspended.pending.planId).not.toBeNull();
    employeePlanId = suspended.pending.planId!;

    const plan = await getAcquisitionPlan(loopCtx, employeePlanId);
    expect(plan.decision).toBe('selected');
    expect(plan.chosen?.kind).toBe('person');
    expect(plan.chosen?.id).toBe(clerkPersonId);
    expect(plan.action).toBe('ask-person');
    // The targeted question is composed deterministically from the mission
    // and addressed to the resolved employee (W012's acceptance).
    expect(plan.question).toContain('Maya Chen');
    expect(plan.question).toContain('Which steps of AP invoice processing');
    // The ASK policy evaluation is recorded on the plan (§20 uniform gate).
    expect(plan.askPolicy?.outcome).toBe('allowed');
    // The ranking rationale persists all three candidates (ADR-0018).
    expect(plan.ranked.map((r) => r.candidate.kind).sort()).toEqual([
      'external',
      'person',
      'system',
    ]);

    // Maya answers out-of-band; the ANSWER enters as immutable evidence
    // observation with the acquired source as provenance (W012).
    const answered = await recordAcquisitionOutcome(clerkCtx, {
      planId: employeePlanId,
      outcome: 'answered',
      evidence: {
        payload: {
          answer:
            'Intake, data entry and validation are fully automatable — the templates are stable. Only the approval routing must stay human.',
          manualMinutesPerInvoice: 22,
          answeredBy: 'Maya Chen (AP)',
        },
        confidence: { value: 0.65, method: 'employee-answer', basis: 'domain expert, first-hand' },
      },
    });
    employeeAnswerObservationId = answered.outcome?.evidenceObservationId ?? '';
    expect(answered.outcome?.outcome).toBe('answered');
    expect(employeeAnswerObservationId).not.toBe('');
  });

  it('the employee answer updates the mission confidence (cognition resumes)', async () => {
    // Stage 7 resume: the evidence confidence raises the mission's current
    // confidence (0.25 → 0.65, below the 0.9 target — the mission stays
    // open for the system and external legs).
    const trace = await runNextStage(loopCtx, {
      executionId,
      stage: 'knowledge-acquisition',
      missionId,
    });
    expect(trace.state).toBe('running');
    const acquisition = trace.steps[6]!.result as {
      stage: 'knowledge-acquisition';
      decision: string;
      action: string | null;
      missionConfidence: { from: number; to: number } | null;
      missionCompleted: boolean;
    };
    expect(acquisition.decision).toBe('selected');
    expect(acquisition.action).toBe('ask-person');
    expect(acquisition.missionConfidence).toEqual({ from: 0.25, to: 0.65 });
    expect(acquisition.missionCompleted).toBe(false);

    const mission = await getMission(loopCtx, missionId);
    expect(mission.content.status).toBe('active');
    expect(mission.content.currentConfidence).toBe(0.65);
  });

  it('leg 5b — system acquisition: the planner queries the ERP (no repeated attempts)', async () => {
    // The fixture drives the same W012 planner directly for the second
    // family — the confidence update through the missions contract is the
    // documented caller-side orchestration (W012 contract: "updating the
    // mission's confidence from the answer is the caller's job").
    const signals: CandidateSignals[] = [
      {
        kind: 'person',
        id: clerkPersonId,
        label: 'Maya Chen',
        relevance: 1,
        reliability: 0.8,
        freshness: 0.9,
        authority: 0.8,
        expectedQuality: 0.8,
        priorContributionValue: 0.5,
        cost: 1_500,
        access: 'allowed',
      },
      {
        kind: 'system',
        label: 'ERP invoice module',
        relevance: 0.9,
        reliability: 0.95,
        freshness: 0.9,
        authority: 0.85,
        expectedQuality: 0.9,
        priorContributionValue: 0,
        cost: 2_500,
        access: 'allowed',
      },
      {
        kind: 'external',
        label: 'AP automation benchmark 2026',
        relevance: 0.75,
        reliability: 0.7,
        freshness: 0.85,
        authority: 0.75,
        expectedQuality: 0.8,
        priorContributionValue: 0,
        cost: 8_000,
        access: 'allowed',
      },
    ];
    const plan = await planNextAcquisition(loopCtx, {
      missionId,
      candidates: signals,
      actor: { kind: 'system', label: 'aurum-cognition' },
      rationale: 'W049 fixture: the system leg of the acquisition chain',
    });
    systemPlanId = plan.id;
    expect(plan.decision).toBe('selected');
    expect(plan.action).toBe('query-system');
    expect(plan.chosen?.label).toBe('ERP invoice module');
    // Lock 17: the planner does not re-ask the already-attempted employee.
    const personRanking = plan.ranked.find((r) => r.candidate.kind === 'person');
    expect(personRanking?.status).toBe('excluded');
    expect(personRanking?.exclusion).toBe('already_attempted');

    const answered = await recordAcquisitionOutcome(loopCtx, {
      planId: systemPlanId,
      outcome: 'answered',
      evidence: {
        payload: {
          report: 'Q3 AP activity',
          invoicesProcessed: 3_412,
          manualMinutesPerInvoice: 22,
          reEntriesPerInvoice: 2.1,
          validationWaitMinutes: 120,
        },
        confidence: { value: 0.8, method: 'system-report', basis: 'ERP query, Q3 window' },
      },
    });
    systemAnswerObservationId = answered.outcome?.evidenceObservationId ?? '';
    expect(answered.outcome?.outcome).toBe('answered');

    // The caller-side confidence update: 0.65 → 0.8 (below target — the
    // external leg is still needed).
    const mission = await reviseMission(loopCtx, {
      missionId,
      currentConfidence: 0.8,
      actor: { kind: 'system', label: 'aurum-cognition' },
      rationale: `acquisition plan ${systemPlanId} answered with evidence confidence 0.8`,
    });
    expect(mission.content.currentConfidence).toBe(0.8);
  });

  it('leg 5c — external acquisition: the planner fetches the benchmark; the mission completes', async () => {
    const plan = await planNextAcquisition(loopCtx, {
      missionId,
      candidates: [
        {
          kind: 'person',
          id: clerkPersonId,
          label: 'Maya Chen',
          relevance: 1,
          reliability: 0.8,
          freshness: 0.9,
          authority: 0.8,
          expectedQuality: 0.8,
          priorContributionValue: 0.5,
          cost: 1_500,
          access: 'allowed',
        },
        {
          kind: 'system',
          label: 'ERP invoice module',
          relevance: 0.9,
          reliability: 0.95,
          freshness: 0.9,
          authority: 0.85,
          expectedQuality: 0.9,
          priorContributionValue: 0,
          cost: 2_500,
          access: 'allowed',
        },
        {
          kind: 'external',
          label: 'AP automation benchmark 2026',
          relevance: 0.85,
          reliability: 0.75,
          freshness: 0.95,
          authority: 0.8,
          expectedQuality: 0.85,
          priorContributionValue: 0,
          cost: 8_000,
          access: 'allowed',
        },
      ],
      actor: { kind: 'system', label: 'aurum-cognition' },
      rationale: 'W049 fixture: the external leg of the acquisition chain',
    });
    externalPlanId = plan.id;
    expect(plan.decision).toBe('selected');
    expect(plan.action).toBe('fetch-external');
    expect(plan.chosen?.kind).toBe('external');
    // Both earlier attempts are deterministically excluded now.
    const excluded = plan.ranked
      .filter((r) => r.status === 'excluded')
      .map((r) => r.candidate.kind);
    expect(excluded.sort()).toEqual(['person', 'system']);

    const answered = await recordAcquisitionOutcome(loopCtx, {
      planId: externalPlanId,
      outcome: 'answered',
      evidence: {
        payload: {
          benchmark: 'AP automation benchmark 2026',
          finding:
            'Top-quartile AP teams automate intake, data entry and validation end-to-end; approval routing stays human',
          expectedManualMinutesPerInvoice: 8,
        },
        confidence: {
          value: 0.92,
          method: 'external-benchmark',
          basis: 'industry benchmark panel',
        },
      },
    });
    externalAnswerObservationId = answered.outcome?.evidenceObservationId ?? '';
    expect(answered.outcome?.outcome).toBe('answered');

    // The confidence gap closes (0.92 ≥ 0.9): the mission completes with
    // what was achieved — the same orchestration cognition applies in-loop.
    const mission = await completeMission(loopCtx, {
      missionId,
      achievedConfidence: 0.92,
      outcome:
        'Intake, data entry and validation are automatable; approval routing stays human. Manual effort today: 22 min/invoice (ERP), benchmark target 8.',
      actor: { kind: 'system', label: 'aurum-cognition' },
    });
    expect(mission.content.status).toBe('completed');
    expect(mission.completion?.achievedConfidence).toBe(0.92);
  });

  it('leg 6 — belief update: stage 8 forms the working understanding from the evidence', async () => {
    const trace = await runNextStage(loopCtx, {
      executionId,
      stage: 'model-update',
      belief: {
        proposition:
          'AP invoice intake, data entry and validation are automatable; approval routing must remain human',
        confidence: { value: 0.65, method: 'evidence-weighing', basis: 'AP clerk answer' },
        supportingObservationIds: [triggerObservationId, employeeAnswerObservationId],
        supportingClaimIds: claimIds,
        alternatives: [
          'Only data entry is automatable; validation requires human judgment for exceptions',
        ],
        disconfirmation:
          'An ERP change log showing validation rule changes too frequent for automated templates',
        subject: { kind: 'world.entity', id: processEntityId },
        validFrom: '2026-09-08T10:00:00.000Z',
        rationale: 'W049 cycle model-update: employee answer weighed against the claims',
      },
    });
    const update = trace.steps[7]!.result as {
      stage: 'model-update';
      beliefId: string | null;
      beliefVersion: number | null;
    };
    beliefId = update.beliefId ?? '';
    expect(beliefId).not.toBe('');
    expect(update.beliefVersion).toBe(1);
  });

  it('the belief revises with the system and external evidence (per-version provenance)', async () => {
    const belief = await reviseBelief(loopCtx, {
      beliefId,
      proposition:
        'AP invoice intake, data entry and validation are automatable end-to-end (ERP data confirms 22 manual minutes today; benchmark confirms 8 is achievable); approval routing must remain human',
      confidence: {
        value: 0.9,
        method: 'evidence-weighing',
        basis: 'employee + system + external answers',
      },
      supportingObservationIds: [
        employeeAnswerObservationId,
        systemAnswerObservationId,
        externalAnswerObservationId,
      ],
      supportingClaimIds: claimIds,
      alternatives: [
        'Only data entry is automatable; validation requires human judgment for exceptions',
      ],
      disconfirmation:
        'An ERP change log showing validation rule changes too frequent for automated templates',
      subject: { kind: 'world.entity', id: processEntityId },
      validFrom: '2026-09-08T11:00:00.000Z',
      rationale: 'W049: all three acquisition families weighed; mission confidence 0.92',
    });
    expect(belief.version).toBe(2);
    expect(belief.provenance.observationIds).toHaveLength(3);

    const history = await listBeliefHistory(loopCtx, { beliefId });
    expect(history.map((v) => v.version)).toEqual([1, 2]);
    // Lock 11: every version carries its own provenance, and history is
    // never rewritten — v1 retains the employee-only evidence set.
    expect(history[0]!.provenance.observationIds).not.toContain(systemAnswerObservationId);
    expect(history[1]!.provenance.observationIds).toContain(systemAnswerObservationId);
    expect(history[1]!.provenance.observationIds).toContain(externalAnswerObservationId);
  });
});

// ---------------------------------------------------------------------------
// Leg 7 — opportunity/inefficiency
// ---------------------------------------------------------------------------

describe('W049 · leg 7 — inefficiency: process reconstruction from the evidence', () => {
  it('reconstructs the AP process and derives the evidence-cited findings', async () => {
    const process = await reconstructProcess(loopCtx, {
      name: 'AP invoice processing',
      scope: {
        eventTypes: [
          'invoice.received',
          'invoice.data-entry',
          'invoice.validated',
          'invoice.posted',
        ],
        observationKinds: ['invoice.audit-note'],
        caseKeyCandidates: ['caseId'],
        occurredFrom: iso(CASE_BASE_MS - 60_000),
        occurredTo: iso(CASE_BASE_MS + 3 * 86_400_000),
        worldEntityId: processEntityId,
      },
      actor: { kind: 'system', label: 'aurum-cognition' },
      rationale: 'W049: reconstruct how AP invoice work actually occurs',
    });
    processId = process.id;
    expect(process.version).toBe(1);
    expect(process.stats.caseCount).toBe(CASES.length);
    expect(process.stats.eventCount).toBe(CASES.length * CASE_TIMELINE.length);
    expect(process.stats.observationCount).toBe(1); // the audit note
    expect(process.findingCounts).toEqual(
      expect.objectContaining({ bottleneck: 1, duplication: 1, manualEffort: 1 }),
    );

    // Bottleneck: data-entry → validated waits 2h on average (3 instances).
    const findings = await listProcessFindings(loopCtx, { processId });
    const bottleneck = findings.find((f) => f.kind === 'bottleneck');
    expect(bottleneck?.subject).toBe('edge:invoice.data-entry->invoice.validated');
    expect(bottleneck?.metrics.avgWaitSeconds).toBe(7_200);
    // Every finding cites the exact events/observations that justify it.
    for (const id of bottleneck?.evidenceEventIds ?? []) expect(processEventIds).toContain(id);

    // Duplication: data entry repeats within a single case (rework).
    const duplication = findings.find((f) => f.kind === 'duplication');
    expect(duplication?.subject).toBe('step:invoice.data-entry');
    expect(duplication?.metrics.casesWithRepetition).toBe(CASES.length);

    // Manual effort: data entry is 100% person-performed — about the WORK,
    // never a worker assessment (W016 discipline).
    const manual = findings.find((f) => f.kind === 'manual_effort');
    expect(manual?.subject).toBe('step:invoice.data-entry');
    expect(manual?.metrics.manualShare).toBe(1);

    // The observation evidence surface participates: the audit note is part
    // of the reconstructed model's evidence (its own case grouping).
    expect(auditNoteObservationId).not.toBe('');
  });

  it('declares the automation capability requirement — the gap is uncovered', async () => {
    const capability = await registerCapability(loopCtx, {
      name: 'ap-invoice-automation',
      description:
        'Automated AP invoice intake, data entry and validation with human approval routing',
      actor: { kind: 'system', label: 'aurum-cognition' },
      rationale: 'W049: the capability the reconstructed process needs',
    });
    capabilityId = capability.id;

    await registerRequirement(loopCtx, {
      capabilityId,
      source: { kind: 'process', id: processId, label: 'AP invoice processing' },
      level: 0.8,
      note: 'Bottleneck + duplication + manual effort findings on the reconstructed process',
      actor: { kind: 'system', label: 'aurum-cognition' },
      rationale: 'W049: the process demands the automation capability',
    });

    // Before the change: uncovered, and the requirement is unmet.
    const before = await analyzeGaps(loopCtx, { capabilityId });
    const gap = before.find((g) => g.capability.id === capabilityId);
    expect(gap?.status).toBe('uncovered');
    expect(gap?.unmet).toHaveLength(1);
    expect(gap?.activeSupplyCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Legs 8+9 — recommendation → approved capability change
// ---------------------------------------------------------------------------

describe('W049 · legs 8+9 — recommendation, approval, capability change', () => {
  it('leg 8 — stage 9+10: records the findings and proposes the capability change', async () => {
    // Stage 9 — the derived intelligence (§19): an opportunity finding and
    // the capability-gap finding, evidence-linked and goal-linked.
    const analyzed = await runNextStage(loopCtx, {
      executionId,
      stage: 'risk-opportunity-capability-analysis',
      findings: [
        {
          kind: 'opportunity',
          statement:
            'Automating AP invoice intake, entry and validation removes ~14 manual minutes per invoice (22 → 8) across ~3,400 invoices per quarter',
          evidenceObservationIds: [
            employeeAnswerObservationId,
            systemAnswerObservationId,
            externalAnswerObservationId,
          ],
          affectedGoalIds: [goalId],
        },
        {
          kind: 'capability-gap',
          statement:
            "The AP process requires the 'ap-invoice-automation' capability at level 0.8; no supplier currently provides it",
          evidenceObservationIds: [systemAnswerObservationId, backlogObservationId],
          affectedGoalIds: [goalId],
        },
      ],
    });
    const analysis = analyzed.steps[8]!.result as {
      stage: 'risk-opportunity-capability-analysis';
      findings: { kind: string }[];
    };
    expect(analysis.findings.map((f) => f.kind).sort()).toEqual(['capability-gap', 'opportunity']);

    // Stage 10 — THE POLICY GATE: the consequential capability change is
    // proposed at the EXECUTE level and the matrix demands human approval.
    const suspended = await runNextStage(loopCtx, {
      executionId,
      stage: 'recommendation-ask-proposal-action',
      action: {
        actionKind: 'capability-change',
        authorityLevel: 'EXECUTE',
        payload: {
          change: 'register-supply',
          capabilityId,
          capabilityName: 'ap-invoice-automation',
          supplier: { kind: 'software', label: 'FlowBridge AP Automation' },
          level: 0.9,
          expectedEffect: 'manual minutes per invoice 22 → at most 10 (goal threshold)',
        },
        justification:
          'Evidence-backed by three acquisition families; process findings show the 2h validation bottleneck and duplicated manual entry; goal threshold is 10 manual minutes per invoice',
      },
    });
    expect(suspended.state).toBe('awaiting_approval');
    expect(suspended.pending.requestId).not.toBeNull();
    actionRequestId = suspended.pending.requestId!;

    const request = await getActionRequest(loopCtx, { requestId: actionRequestId });
    expect(request.status).toBe('pending');
    expect(request.actionKind).toBe('capability-change');
    expect(request.authorityLevel).toBe('EXECUTE');
    expect(request.evaluation.outcome).toBe('approval_required');
  });

  it('the requesting principal cannot approve its own proposal (separation of duties)', async () => {
    await expect(
      decideApproval(loopCtx, { requestId: actionRequestId, decision: 'approve' }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    // The request is still pending.
    const request = await getActionRequest(loopCtx, { requestId: actionRequestId });
    expect(request.status).toBe('pending');
  });

  it('leg 9 — a human approves; the loop records the authorized outcome and learns', async () => {
    const decision = await decideApproval(approverCtx, {
      requestId: actionRequestId,
      decision: 'approve',
      note: 'Cost program committee sign-off; pilot the FlowBridge integration on AP',
    });
    expect(decision.status).toBe('approved');

    // Stage 10 resume: the suspension releases.
    const resumed = await runNextStage(loopCtx, {
      executionId,
      stage: 'recommendation-ask-proposal-action',
      action: null,
    });
    expect(resumed.state).toBe('running');
    const gate = resumed.steps[9]!.result as {
      stage: 'recommendation-ask-proposal-action';
      gate: string | null;
      resolution: string | null;
      actionRequest: { status: string } | null;
    };
    expect(gate.gate).toBe('approval_required');
    expect(gate.resolution).toBe('approved');
    expect(gate.actionRequest?.status).toBe('approved');

    // Stage 11 — the outcome is recorded, never silent.
    const withOutcome = await runNextStage(loopCtx, {
      executionId,
      stage: 'outcome',
      summary:
        'Capability change approved by the cost committee: register the FlowBridge AP automation supply covering the ap-invoice-automation requirement',
    });
    const outcomeStep = withOutcome.steps[10]!.result as {
      stage: 'outcome';
      kind: string;
      actionRequestId: string | null;
    };
    expect(outcomeStep.kind).toBe('action-authorized');
    expect(outcomeStep.actionRequestId).toBe(actionRequestId);

    // Stage 12 — the durable learning, citing the cycle's observations.
    const completed = await runNextStage(loopCtx, {
      executionId,
      stage: 'learning',
      knowledge: {
        title: 'AP invoice automation is evidence-backed and committee-approved',
        summary:
          'Employee, ERP and external benchmark evidence agree: intake, entry and validation are automatable (22 → 8 manual minutes per invoice); approval routing stays human. The capability change was approved and the supply registered.',
        topics: [...FOCUS_TOPICS],
      },
    });
    expect(completed.state).toBe('completed');
    expect(completed.completedStages).toBe(12);
    expect(completed.outcome?.kind).toBe('action-authorized');
    const learningStep = completed.steps[11]!.result as {
      stage: 'learning';
      knowledgeEntryId: string | null;
    };
    expect(learningStep.knowledgeEntryId).not.toBeNull();
  });

  it('the APPROVED change executes through the capability graph: uncovered → covered', async () => {
    // Only now — after the approval — is the supply registered (the loop
    // acts when authorized, §2; the supply cites the acquisition evidence
    // and the approval note references the gated request).
    const supply = await registerSupply(loopCtx, {
      capabilityId,
      supplier: { kind: 'software', label: 'FlowBridge AP Automation' },
      level: 0.9,
      evidenceObservationIds: [
        employeeAnswerObservationId,
        systemAnswerObservationId,
        externalAnswerObservationId,
      ],
      note: `Authorized by approved action request ${actionRequestId}`,
      actor: { kind: 'system', label: 'aurum-cognition' },
      rationale: 'W049: execute the approved capability change',
    });
    expect(supply.status).toBe('active');

    const after = await analyzeGaps(loopCtx, { capabilityId });
    const gap = after.find((g) => g.capability.id === capabilityId);
    expect(gap?.status).toBe('covered');
    expect(gap?.unmet).toHaveLength(0);
    expect(gap?.activeSupplyCount).toBe(1);
    // The registered supply is the available alternative that closed it.
    expect(gap?.alternatives.activeByKind.software).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Leg 10 — measured outcome
// ---------------------------------------------------------------------------

describe('W049 · leg 10 — measured outcome', () => {
  it('observes the post-change metric and settles expected-versus-realized', async () => {
    // The post-deployment measurement (another immutable observation).
    const postChange = await recordObservation(loopCtx, {
      kind: 'metric.sample',
      payload: {
        metric: 'manual-minutes-per-invoice',
        value: 8.5,
        unit: 'minutes',
        window: '2026-Q4',
        source: 'ERP invoice module after FlowBridge go-live',
      },
      observedAt: '2026-12-15T08:00:00.000Z',
      source: { kind: 'system', label: 'ERP invoice module' },
      channel: 'api',
      confidence: { value: 0.95, method: 'system-report' },
    });
    postChangeObservationId = postChange.id;

    // The outcome ties the RECOMMENDATION (the approved action request) to
    // the goal's own metric: baseline from the ERP answer (22), expected
    // from the goal threshold (10), direction at_most.
    const outcome = await defineOutcome(loopCtx, {
      subject: {
        kind: 'recommendation',
        id: actionRequestId,
        label: 'capability-change: FlowBridge AP automation supply',
      },
      metricName: 'manual minutes per invoice',
      metricUnit: 'minutes',
      direction: 'at_most',
      baseline: 22,
      expected: 10,
      horizon: '2027-06-30',
      affectedGoals: [{ goalId, label: 'Cut AP invoice processing cost' }],
      originExecutionId: executionId,
      actor: { kind: 'system', label: 'aurum-cognition' },
      rationale: 'W049: measure the approved capability change against the goal threshold',
    });
    outcomeId = outcome.id;
    expect(outcome.status).toBe('open');
    expect(outcome.expected).toBe(10);
    expect(outcome.baseline).toBe(22);
    expect(outcome.originExecutionId).toBe(executionId);

    const measurement = await recordMeasurement(loopCtx, {
      outcomeId,
      value: 8.5,
      note: 'First full quarter after FlowBridge go-live',
      evidence: [{ kind: 'observation', id: postChangeObservationId }],
      actor: { kind: 'system', label: 'aurum-cognition' },
    });
    measurementId = measurement.id;
    expect(measurement.value).toBe(8.5);

    // Settlement freezes the assessment: realized 8.5 < expected 10 with
    // direction at_most → 'exceeded' (better than the commitment), and the
    // improvement versus the 22-minute baseline is recorded.
    const settled = await settleOutcome(loopCtx, {
      outcomeId,
      measurementId,
      note: 'Q4 ERP measurement settles the outcome',
      actor: { kind: 'system', label: 'aurum-cognition' },
    });
    expect(settled.status).toBe('settled');
    expect(settled.realization?.assessment).toBe('exceeded');
    expect(settled.realization?.varianceVsExpected).toBe(-1.5);
    expect(settled.realization?.improvementVsBaseline).toBe(-13.5);

    const reread = await getOutcome(loopCtx, outcomeId);
    expect(reread.realization?.fromMeasurementId).toBe(measurementId);
    expect(reread.realization?.realizedValue).toBe(8.5);
  });
});

// ---------------------------------------------------------------------------
// Closure — the chain is reconstructable and tenant-scoped
// ---------------------------------------------------------------------------

describe('W049 · closure — the chain is reconstructable and tenant-scoped', () => {
  it('resolves the unknown with the belief that closed it', async () => {
    const resolved = await resolveUnknown(loopCtx, {
      unknownId,
      resolution: { kind: 'belief', id: beliefId },
      note: 'Closed by the mission: three acquisition families agree on the automatable scope',
    });
    expect(resolved.status).toBe('resolved');
    expect(resolved.resolution?.id).toBe(beliefId);
    expect(resolved.resolvedAt).not.toBeNull();
  });

  it('the twelve-step trace reconstructs the whole chain in canonical order', async () => {
    const trace: CognitiveExecutionTrace = await getExecution(loopCtx, { executionId });
    expect(trace.steps.map((s) => s.stage)).toEqual([
      'observation',
      'evidence-memory',
      'world-update',
      'epistemic-evaluation',
      'goal-evaluation',
      'unknown-mission-evaluation',
      'knowledge-acquisition',
      'model-update',
      'risk-opportunity-capability-analysis',
      'recommendation-ask-proposal-action',
      'outcome',
      'learning',
    ]);
    // §24 reconstructability: the trace's action request is the one that
    // was approved, and the outcome references it.
    const actionStep = trace.steps[9]!.result as {
      stage: 'recommendation-ask-proposal-action';
      actionRequest: { id: string } | null;
    };
    expect(actionStep.actionRequest?.id).toBe(actionRequestId);
    expect(trace.outcome?.actionRequestId).toBe(actionRequestId);
  });

  it('the completed mission and its acquisition audit trail survive on the contracts', async () => {
    const mission = await getMission(loopCtx, missionId);
    expect(mission.content.status).toBe('completed');
    expect(mission.content.unknownIds).toEqual([unknownId]);

    // Three plans, three families, three distinct actions — the append-only
    // audit trail of how Aurum investigated (ADR-0018).
    const plans: AcquisitionPlan[] = [];
    for (const planId of [employeePlanId, systemPlanId, externalPlanId]) {
      plans.push(await getAcquisitionPlan(loopCtx, planId));
    }
    expect(plans.map((p) => p.action)).toEqual(['ask-person', 'query-system', 'fetch-external']);
    expect(plans.every((p) => p.outcome?.outcome === 'answered')).toBe(true);
    expect(new Set(plans.map((p) => p.outcome?.evidenceObservationId)).size).toBe(3);
  });

  it('a foreign tenant sees none of the chain (ADR-0001, no existence leak)', async () => {
    const foreign: TenantContext = { tenantId: newId(), principalId: newId(), authority: [] };
    await expect(getExecution(foreign, { executionId })).rejects.toBeInstanceOf(CognitionError);
    await expect(getExecution(foreign, { executionId })).rejects.toMatchObject({
      code: 'execution_not_found',
    });
    await expect(getMission(foreign, missionId)).rejects.toBeInstanceOf(MissionsError);
    await expect(getMission(foreign, missionId)).rejects.toMatchObject({
      code: 'mission_not_found',
    });
    await expect(getOutcome(foreign, outcomeId)).rejects.toBeInstanceOf(LearningError);
    await expect(getOutcome(foreign, outcomeId)).rejects.toMatchObject({
      code: 'outcome_not_found',
    });
    await expect(listProcessFindings(foreign, { processId })).rejects.toBeInstanceOf(
      ProcessesError,
    );
    await expect(
      resolveUnknown(foreign, { unknownId, note: 'must not resolve' }),
    ).rejects.toBeInstanceOf(EpistemicsError);
  });
});
