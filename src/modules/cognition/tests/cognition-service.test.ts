// Integration tests for the cognition module against the embedded
// PostgreSQL (PGlite, `:memory:`) through the db port. Covers the W013
// acceptance — "the canonical company intelligence loop as explicit
// asynchronous/resumable executions with policy gates and outcome
// recording":
//
//  * EXPLICIT executions: startExecution records identity, trigger,
//    focus, actor, §25 correlation/causation identities and mints the
//    lifecycle; observation triggers are validated readable through the
//    observations contract; an execution-caused execution inherits its
//    cause's correlation id; roots correlate to themselves.
//  * CANONICAL: the twelve §19 stages run in frozen order — a wrong
//    stage discriminator is `stage_mismatch`; every stage appends
//    exactly one traceable step (input snapshot + structured result);
//    the full happy path drives the REAL sibling contracts (W004
//    observation intake, W010 evidence retrieval + learning capture,
//    W005 world update, W007 claims/unknowns/belief, W008 goal
//    evaluation, W011 mission launch + confidence orchestration, W012
//    acquisition planning/outcome).
//  * ASYNCHRONOUS/RESUMABLE (lock 36): the knowledge-acquisition stage
//    suspends 'awaiting_input' until the plan carries its terminal
//    outcome; the resume raises the mission's confidence from the
//    answer's evidence (reviseMission below target, completeMission at
//    or above target — the orchestration W012 documents as W013's job);
//    unanswered re-checks return the unchanged execution; abandonment
//    works from live and suspended states; concurrent pumps lose
//    cleanly with `execution_conflict`.
//  * POLICY GATES (§20): the action stage routes one consequential
//    action through the actions authority matrix with a stable
//    idempotency key — allowed releases (outcome action-authorized),
//    forbidden refuses (outcome action-refused, the loop still records
//    its outcome and learning), approval_required suspends
//    'awaiting_approval' until a human approve/reject releases it.
//  * OUTCOME RECORDING (§24): the outcome stage writes the cycle's
//    outcome (kind + summary + action request reference); the learning
//    stage captures evidence-backed knowledge (W010) citing the cycle's
//    observations; completion requires all twelve stages.
//  * APPEND-ONLY TRACE: PostgreSQL triggers reject UPDATE/DELETE/TRUNCATE
//    on steps and DELETE/TRUNCATE on executions.
//  * Tenant isolation (ADR-0001) with uniform not-found semantics and
//    uniform `invalid_reference` for foreign stage references.
//  * The trace/step/list read surface.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import {
  ACTIONS_AUTHORITY_ADMINISTER,
  ACTIONS_AUTHORITY_APPROVE,
  authorizeAction,
  decideApproval,
  getActionRequest,
  setAuthorityPolicy,
} from '@/modules/actions/contract';
import { createGoal } from '@/modules/goals/contract';
import { getAcquisitionPlan, recordAcquisitionOutcome } from '@/modules/knowledge-acquisition/contract';
import { getMission } from '@/modules/missions/contract';
import { getObservation, recordObservation } from '@/modules/observations/contract';
import { CognitionError } from '../errors';
import * as cognitionContract from '../contract';
import type {
  ActionProposalInput,
  CognitiveExecution,
  CognitiveExecutionTrace,
  StartExecutionInput,
} from '../types';
import { runMigrations } from '../../../../scripts/migrate';

const {
  abandonExecution,
  getExecution,
  getExecutionStep,
  listExecutions,
  runNextStage,
  startExecution,
} = cognitionContract;

// Dedicated tenants keep each concern's data isolated from the others.
const tenantLoop = newId();
const tenantGate = newId();
const tenantForbidden = newId();
const tenantAcq = newId();
const tenantIso = newId();
const tenantConflict = newId();
const tenantAudit = newId();
const tenantCorrelation = newId();
const tenantList = newId();

const PERSON_ID = '0b2f8e2a-1c4b-4d8a-9f3e-7a2b6c5d4e8f';

function member(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: [] };
}

function admin(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: [ACTIONS_AUTHORITY_ADMINISTER] };
}

function approver(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: [ACTIONS_AUTHORITY_APPROVE] };
}

async function expectCode(code: string, fn: () => unknown): Promise<void> {
  try {
    await fn();
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(CognitionError);
    expect((error as CognitionError).code).toBe(code);
  }
}

/** Seeds one active goal through the goals contract; returns its id. */
async function seedGoal(ctx: TenantContext, title: string): Promise<string> {
  const goal = await createGoal(ctx, {
    title,
    objective: `Objective of ${title}`,
    desiredState: `${title} achieved`,
    horizonEnd: '2027-06-30T00:00:00.000Z',
    owner: { kind: 'person', id: PERSON_ID, label: 'COO' },
    priority: 'high',
    successCriteria: `${title} success criteria`,
    actor: { kind: 'person', id: PERSON_ID },
    rationale: 'test seed',
  });
  return goal.id;
}

/** Seeds one tenant-visible observation through the observations contract. */
async function seedObservation(ctx: TenantContext, payload: unknown): Promise<string> {
  const observation = await recordObservation(ctx, {
    kind: 'channel.message',
    payload,
    observedAt: new Date().toISOString(),
    source: { kind: 'source', label: 'slack' },
    channel: 'slack',
    confidence: { value: 0.8, method: 'test' },
  });
  return observation.id;
}

function startInput(overrides: Partial<StartExecutionInput> = {}): StartExecutionInput {
  return {
    trigger: { kind: 'system', label: 'nightly-cycle' },
    focus: { topics: ['churn', 'pricing'], entities: [] },
    actor: { kind: 'system', label: 'aurum-cognition' },
    rationale: 'W013 test cycle',
    ...overrides,
  };
}

/** One minimal observation intake for the observation stage. */
function observationIntake(payload: unknown = { text: 'churn spiked 12% in Q3' }) {
  return {
    kind: 'channel.message',
    payload,
    observedAt: new Date().toISOString(),
    source: { kind: 'source', label: 'slack' },
    channel: 'slack',
    confidence: { value: 0.8, method: 'test' },
  };
}

/** Drives the minimal cycle from the execution's CURRENT position up to (excluding) `upto`. */
async function driveMinimal(
  ctx: TenantContext,
  executionId: string,
  upto: number,
): Promise<CognitiveExecutionTrace> {
  let trace = await getExecution(ctx, { executionId });
  for (let stage = trace.completedStages + 1; stage < upto; stage += 1) {
    trace = await runMinimalStage(ctx, executionId, stage, trace);
  }
  return trace;
}

async function runMinimalStage(
  ctx: TenantContext,
  executionId: string,
  stage: number,
  trace: CognitiveExecutionTrace,
): Promise<CognitiveExecutionTrace> {
  expect(trace.nextStage).not.toBeNull();
  const next = trace.nextStage!;
  switch (stage) {
    case 1:
      return runNextStage(ctx, { executionId, stage: 'observation', record: [observationIntake()] });
    case 2:
      expect(next).toBe('evidence-memory');
      return runNextStage(ctx, { executionId, stage: 'evidence-memory' });
    case 3:
      expect(next).toBe('world-update');
      return runNextStage(ctx, { executionId, stage: 'world-update', update: null });
    case 4:
      expect(next).toBe('epistemic-evaluation');
      return runNextStage(ctx, { executionId, stage: 'epistemic-evaluation', claims: [] });
    case 5:
      expect(next).toBe('goal-evaluation');
      return runNextStage(ctx, { executionId, stage: 'goal-evaluation', relatedGoalIds: [] });
    case 6:
      expect(next).toBe('unknown-mission-evaluation');
      return runNextStage(ctx, { executionId, stage: 'unknown-mission-evaluation', unknowns: [], missions: [] });
    case 7:
      expect(next).toBe('knowledge-acquisition');
      return runNextStage(ctx, { executionId, stage: 'knowledge-acquisition', missionId: null });
    case 8:
      expect(next).toBe('model-update');
      return runNextStage(ctx, { executionId, stage: 'model-update', belief: null });
    case 9:
      expect(next).toBe('risk-opportunity-capability-analysis');
      return runNextStage(ctx, {
        executionId,
        stage: 'risk-opportunity-capability-analysis',
        findings: [],
      });
    case 10:
      expect(next).toBe('recommendation-ask-proposal-action');
      return runNextStage(ctx, { executionId, stage: 'recommendation-ask-proposal-action', action: null });
    case 11:
      expect(next).toBe('outcome');
      return runNextStage(ctx, { executionId, stage: 'outcome', summary: 'cycle closed' });
    case 12:
      expect(next).toBe('learning');
      return runNextStage(ctx, { executionId, stage: 'learning', knowledge: null });
    default:
      throw new Error(`unexpected stage ${stage}`);
  }
}

beforeAll(async () => {
  await runMigrations(getDb());
});

afterAll(async () => {
  await closeDb();
});

describe('contract surface (the module exposes exactly its public operations)', () => {
  it('pins the export set — no mutation or erase operation exists', async () => {
    // There is deliberately no updateStep, no rewriteOutcome, no
    // un-abandon and no delete: the trace is append-only (triggers) and
    // lifecycle transitions are the dedicated operations above.
    expect(Object.keys(cognitionContract).sort()).toEqual([
      'ABANDONABLE_STATES',
      'ADVANCEABLE_STATES',
      'ANALYSIS_FINDING_KINDS',
      'CognitionError',
      'DEFAULT_INVESTIGATION_COST',
      'DEFAULT_LIST_LIMIT',
      'EXECUTION_ACTOR_KINDS',
      'EXECUTION_CAUSATION_KINDS',
      'EXECUTION_OUTCOME_KINDS',
      'EXECUTION_STATES',
      'EXECUTION_TRIGGER_KINDS',
      'FINAL_STAGE_NUMBER',
      'LOOP_STAGES',
      'MAX_ALTERNATIVES',
      'MAX_CHANNEL_LENGTH',
      'MAX_CLAIMS_PER_STAGE',
      'MAX_EVIDENCE_REFS',
      'MAX_FINDINGS_PER_STAGE',
      'MAX_FOCUS_ENTITIES',
      'MAX_FOCUS_TOPICS',
      'MAX_JUSTIFICATION_LENGTH',
      'MAX_KIND_LENGTH',
      'MAX_LABEL_LENGTH',
      'MAX_LIST_LIMIT',
      'MAX_METHOD_LENGTH',
      'MAX_MISSIONS_PER_STAGE',
      'MAX_NOTE_LENGTH',
      'MAX_PROPOSITION_LENGTH',
      'MAX_RATIONALE_LENGTH',
      'MAX_REASON_LENGTH',
      'MAX_RECORDED_OBSERVATIONS',
      'MAX_REFERENCED_OBSERVATIONS',
      'MAX_RELATED_GOALS',
      'MAX_STAGE_INPUT_BYTES',
      'MAX_STATEMENT_LENGTH',
      'MAX_SUMMARY_LENGTH',
      'MAX_TITLE_LENGTH',
      'MAX_TOPIC_LENGTH',
      'MAX_UNKNOWNS_PER_STAGE',
      'NEUTRAL_SIGNAL',
      'abandonExecution',
      'deriveAcquisitionSignals',
      'getExecution',
      'getExecutionStep',
      'isExecutionCausationKind',
      'isExecutionOutcomeKind',
      'isExecutionState',
      'isExecutionTriggerKind',
      'isLoopStage',
      'isUuid',
      'listExecutions',
      'nextStageAfterCompleted',
      'outcomeKindForActionGate',
      'personTopicCoverage',
      'runNextStage',
      'stageAtNumber',
      'stageNumberOf',
      'startExecution',
    ]);
  });
});

describe('startExecution (the explicit cycle record)', () => {
  it('records an execution with system-minted lifecycle and no stage work', async () => {
    const ctx = member(tenantLoop);
    const before = new Date();
    const trace = await startExecution(ctx, startInput());
    const after = new Date();

    expect(trace.state).toBe('running');
    expect(trace.completedStages).toBe(0);
    expect(trace.nextStage).toBe('observation');
    expect(trace.steps).toEqual([]);
    expect(trace.pending).toEqual({ planId: null, requestId: null });
    expect(trace.outcome).toBeNull();
    expect(trace.abandonment).toBeNull();
    expect(trace.startedByPrincipal).toBe(ctx.principalId);
    expect(trace.trigger).toEqual({ kind: 'system', id: null, label: 'nightly-cycle' });
    expect(trace.focus.topics).toEqual(['churn', 'pricing']);
    expect(trace.actor).toEqual({ kind: 'system', id: null, label: 'aurum-cognition' });
    // Roots correlate to themselves (§25).
    expect(trace.correlationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(trace.causation).toBeNull();
    for (const stamp of [trace.createdAt, trace.updatedAt]) {
      expect(Date.parse(stamp)).toBeGreaterThanOrEqual(before.getTime());
      expect(Date.parse(stamp)).toBeLessThanOrEqual(after.getTime());
    }
  });

  it('validates an observation trigger readable through the observations contract', async () => {
    const ctx = member(tenantLoop);
    const observationId = await seedObservation(ctx, { signal: 'trigger' });
    const trace = await startExecution(
      ctx,
      startInput({ trigger: { kind: 'observation', id: observationId, label: null } }),
    );
    expect(trace.trigger).toEqual({ kind: 'observation', id: observationId, label: null });
  });

  it('rejects observation triggers that are missing or not readable (uniformly)', async () => {
    const ctx = member(tenantLoop);
    await expectCode('invalid_start_input', () =>
      startExecution(ctx, startInput({ trigger: { kind: 'observation', id: null, label: null } })),
    );
    await expectCode('invalid_start_input', () =>
      startExecution(
        ctx,
        startInput({ trigger: { kind: 'observation', id: newId(), label: null } }),
      ),
    );
    // A foreign tenant's observation is indistinguishable from a missing one.
    const foreign = await seedObservation(member(tenantIso), { signal: 'foreign' });
    await expectCode('invalid_start_input', () =>
      startExecution(ctx, startInput({ trigger: { kind: 'observation', id: foreign, label: null } })),
    );
  });

  it('inherits the correlation id from a causing execution and keeps explicit ones', async () => {
    const ctx = member(tenantCorrelation);
    const root = await startExecution(ctx, startInput());
    const caused = await startExecution(
      ctx,
      startInput({ causation: { kind: 'execution', id: root.id } }),
    );
    expect(caused.correlationId).toBe(root.correlationId);
    expect(caused.causation).toEqual({ kind: 'execution', id: root.id });

    const explicit = newId();
    const override = await startExecution(
      ctx,
      startInput({ correlationId: explicit, causation: { kind: 'execution', id: root.id } }),
    );
    expect(override.correlationId).toBe(explicit);

    await expectCode('invalid_start_input', () =>
      startExecution(ctx, startInput({ causation: { kind: 'execution', id: newId() } })),
    );
  });

  it('rejects malformed starts (unknown keys, bad shapes, empty focus)', async () => {
    const ctx = member(tenantLoop);
    await expectCode('invalid_start_input', () =>
      startExecution(ctx, { ...startInput(), state: 'completed' } as never),
    );
    await expectCode('invalid_start_input', () =>
      startExecution(ctx, { ...startInput(), focus: { topics: [] } }),
    );
    await expectCode('invalid_start_input', () =>
      startExecution(ctx, { ...startInput(), focus: { topics: ['not a slug!'] } }),
    );
    await expectCode('invalid_start_input', () =>
      startExecution(ctx, { ...startInput(), actor: { kind: 'robot' } } as never),
    );
    await expectCode('invalid_start_input', () =>
      startExecution(ctx, { ...startInput(), correlationId: 'not-a-uuid' }),
    );
  });
});

describe('runNextStage — canonical order and the real loop (§19)', () => {
  it('rejects stage mismatches: the loop order is not negotiable', async () => {
    const ctx = member(tenantLoop);
    const trace = await startExecution(ctx, startInput());
    await expectCode('stage_mismatch', () =>
      runNextStage(ctx, { executionId: trace.id, stage: 'outcome', summary: 'skip ahead' }),
    );
    await expectCode('stage_mismatch', () =>
      runNextStage(ctx, { executionId: trace.id, stage: 'evidence-memory' }),
    );
    // A malformed executionId is a shape error; a well-formed unknown id is
    // uniformly not-found.
    await expectCode('invalid_stage_input', () =>
      runNextStage(ctx, { executionId: 'not-a-uuid', stage: 'observation' } as never),
    );
    await expectCode('execution_not_found', () =>
      runNextStage(ctx, { executionId: newId(), stage: 'observation' }),
    );
  });

  it('runs the full canonical cycle through the real sibling contracts', async () => {
    const ctx = member(tenantLoop);
    const goalId = await seedGoal(ctx, 'Q4 churn reduction');
    const triggerObservationId = await seedObservation(ctx, { signal: 'cycle trigger' });

    const trace0 = await startExecution(
      ctx,
      startInput({
        trigger: { kind: 'observation', id: triggerObservationId, label: null },
        focus: {
          topics: ['churn'],
          entities: [{ kind: 'competitor', label: 'Acme Corp' }],
        },
        actor: { kind: 'system', label: 'aurum-cognition' },
      }),
    );

    // 1 — observation: record one new observation, reference the trigger.
    const step1 = await runNextStage(ctx, {
      executionId: trace0.id,
      stage: 'observation',
      record: [observationIntake({ text: 'support ticket volume up 30%' })],
      reference: [triggerObservationId],
    });
    expect(step1.state).toBe('running');
    expect(step1.completedStages).toBe(1);
    expect(step1.nextStage).toBe('evidence-memory');
    expect(step1.steps).toHaveLength(1);
    const observationResult = step1.steps[0]!.result as Extract<
      typeof step1.steps[0]['result'],
      { stage: 'observation' }
    >;
    expect(observationResult.observationIds).toHaveLength(2);
    expect(observationResult.observationIds).toContain(triggerObservationId);
    expect(observationResult.recordedObservationIds).toHaveLength(1);
    // The recorded observation really exists (W004).
    await getObservation(ctx, observationResult.recordedObservationIds[0]!);

    // 2 — evidence/memory: retrieval through W010.
    const step2 = await runNextStage(ctx, { executionId: trace0.id, stage: 'evidence-memory' });
    const memoryResult = step2.steps[1]!.result as Extract<
      typeof step2.steps[1]['result'],
      { stage: 'evidence-memory' }
    >;
    expect(memoryResult.knowledgeEntryIds).toEqual([]);
    expect(memoryResult.transactiveEntryIds).toEqual([]);

    // 3 — world update: create a competitor entity through W005.
    const step3 = await runNextStage(ctx, {
      executionId: trace0.id,
      stage: 'world-update',
      update: {
        kind: 'create-entity',
        entity: { kind: 'competitor', name: 'Acme Corp', attributes: { region: 'EU' } },
      },
    });
    const worldResult = step3.steps[2]!.result as Extract<
      typeof step3.steps[2]['result'],
      { stage: 'world-update' }
    >;
    expect(worldResult.update).toMatchObject({ kind: 'create-entity' });
    const competitorId = (worldResult.update as { entityId: string }).entityId;

    // 4 — epistemic evaluation: a claim derived from the cycle's evidence.
    const step4 = await runNextStage(ctx, {
      executionId: trace0.id,
      stage: 'epistemic-evaluation',
      claims: [
        {
          proposition: 'Support ticket volume rose materially in Q3.',
          confidence: { value: 0.75, method: 'derived' },
          evidenceObservationIds: observationResult.recordedObservationIds,
          rationale: 'counted from the recorded observation',
        },
      ],
    });
    const claimResult = step4.steps[3]!.result as Extract<
      typeof step4.steps[3]['result'],
      { stage: 'epistemic-evaluation' }
    >;
    expect(claimResult.claimIds).toHaveLength(1);

    // 5 — goal evaluation: the seeded active goal relates.
    const step5 = await runNextStage(ctx, {
      executionId: trace0.id,
      stage: 'goal-evaluation',
      relatedGoalIds: [goalId],
    });
    const goalResult = step5.steps[4]!.result as Extract<
      typeof step5.steps[4]['result'],
      { stage: 'goal-evaluation' }
    >;
    expect(goalResult.goalIds).toEqual([goalId]);
    expect(goalResult.activeGoalCount).toBeGreaterThanOrEqual(1);

    // 6 — unknown/mission evaluation: identify an unknown, launch a mission.
    const step6 = await runNextStage(ctx, {
      executionId: trace0.id,
      stage: 'unknown-mission-evaluation',
      unknowns: [
        {
          question: 'What is the dominant driver of the Q3 churn rise?',
          consequence: 'Churn reduction investments cannot be prioritized without it.',
          relatedObservationIds: observationResult.observationIds,
        },
      ],
      missions: [
        {
          title: 'Churn root cause',
          knowledgeObjective: 'Why did churn rise in Q3 and what is the dominant driver?',
          unknownIds: [], // linked below via the recorded unknown id
          informationValue: 0.8,
          urgency: 'high',
          currentConfidence: 0.1,
          targetConfidence: 0.85,
          investigationBudget: { amount: 250_00, currency: 'EUR' },
          rewardBudget: { amount: 50_00, currency: 'EUR' },
          candidateSources: [{ kind: 'system', label: 'billing-export' }],
          completionCriteria: 'A validated root-cause explanation with confidence >= 0.85.',
        },
      ],
    });
    const unknownMissionResult = step6.steps[5]!.result as Extract<
      typeof step6.steps[5]['result'],
      { stage: 'unknown-mission-evaluation' }
    >;
    expect(unknownMissionResult.unknownIds).toHaveLength(1);
    expect(unknownMissionResult.missionIds).toHaveLength(1);
    // The launched mission exists through the missions contract, driven by
    // the execution's actor.
    const mission = await getMission(ctx, unknownMissionResult.missionIds[0]!);
    expect(mission.content.status).toBe('active');
    expect(mission.lastChange.actor).toEqual({ kind: 'system', id: null, label: 'aurum-cognition' });
    expect(mission.lastChange.rationale).toContain(trace0.id);

    // 7 — knowledge acquisition: the planner selects the system candidate
    // and the execution suspends until the answer lands.
    const step7 = await runNextStage(ctx, {
      executionId: trace0.id,
      stage: 'knowledge-acquisition',
      missionId: mission.id,
    });
    expect(step7.state).toBe('awaiting_input');
    expect(step7.completedStages).toBe(6); // the stage has NOT completed
    expect(step7.nextStage).toBe('knowledge-acquisition');
    expect(step7.steps).toHaveLength(6);
    expect(step7.pending.planId).not.toBeNull();

    // The answer lands through the W012 contract (the worker path).
    const plan = await getAcquisitionPlan(ctx, step7.pending.planId!);
    expect(plan.decision).toBe('selected');
    expect(plan.chosen).toMatchObject({ kind: 'system', label: 'billing-export' });
    await recordAcquisitionOutcome(ctx, {
      planId: plan.id,
      outcome: 'answered',
      evidence: {
        payload: { rootCause: 'pricing change applied to legacy cohorts' },
        confidence: { value: 0.9, method: 'validated-analysis' },
      },
    });

    // 7 (resume) — the mission's confidence rises from the answer's
    // evidence; the gap closes, so the mission completes.
    const step7b = await runNextStage(ctx, {
      executionId: trace0.id,
      stage: 'knowledge-acquisition',
    });
    expect(step7b.state).toBe('running');
    expect(step7b.completedStages).toBe(7);
    expect(step7b.pending.planId).toBeNull();
    const acquisitionResult = step7b.steps[6]!.result as Extract<
      typeof step7b.steps[6]['result'],
      { stage: 'knowledge-acquisition' }
    >;
    expect(acquisitionResult.decision).toBe('selected');
    expect(acquisitionResult.missionId).toBe(mission.id);
    expect(acquisitionResult.outcome).toMatchObject({ kind: 'answered' });
    expect(acquisitionResult.outcome!.evidenceObservationId).not.toBeNull();
    expect(acquisitionResult.missionConfidence).toEqual({ from: 0.1, to: 0.9 });
    expect(acquisitionResult.missionCompleted).toBe(true);
    const completedMission = await getMission(ctx, mission.id);
    expect(completedMission.content.status).toBe('completed');
    expect(completedMission.completion).toMatchObject({ achievedConfidence: 0.9 });

    // 8 — model update: a belief citing the cycle's evidence.
    const step8 = await runNextStage(ctx, {
      executionId: trace0.id,
      stage: 'model-update',
      belief: {
        proposition: 'The Q3 churn rise is dominated by the legacy-cohort pricing change.',
        confidence: { value: 0.9, method: 'mission-evidence' },
        supportingObservationIds: observationResult.observationIds.slice(0, 1),
        supportingClaimIds: claimResult.claimIds,
        alternatives: ['support-load driven churn', 'seasonal effect'],
        validFrom: new Date().toISOString(),
        rationale: 'mission answer reached target confidence',
      },
    });
    const beliefResult = step8.steps[7]!.result as Extract<
      typeof step8.steps[7]['result'],
      { stage: 'model-update' }
    >;
    expect(beliefResult.beliefId).not.toBeNull();
    expect(beliefResult.beliefVersion).toBe(1);

    // 9 — analysis: a finding with evidence and an affected goal.
    const step9 = await runNextStage(ctx, {
      executionId: trace0.id,
      stage: 'risk-opportunity-capability-analysis',
      findings: [
        {
          kind: 'risk',
          statement: 'Legacy-cohort pricing churn threatens the Q4 churn goal.',
          evidenceObservationIds: observationResult.observationIds.slice(0, 1),
          affectedGoalIds: [goalId],
        },
        {
          kind: 'capability-gap',
          statement: 'No cohort-aware pricing analysis capability exists.',
          evidenceObservationIds: [],
          affectedGoalIds: [],
        },
      ],
    });
    const analysisResult = step9.steps[8]!.result as Extract<
      typeof step9.steps[8]['result'],
      { stage: 'risk-opportunity-capability-analysis' }
    >;
    expect(analysisResult.findings).toHaveLength(2);
    expect(analysisResult.findings[0]).toMatchObject({ kind: 'risk', affectedGoalIds: [goalId] });

    // 10 — action: an ASK the default matrix allows (the policy gate).
    const askAction: ActionProposalInput = {
      actionKind: 'employee-messaging',
      authorityLevel: 'ASK',
      payload: { to: 'vp-cs', question: 'Can you validate the cohort-pricing churn hypothesis?' },
      justification: 'validate the mission answer with the accountable owner',
    };
    const step10 = await runNextStage(ctx, {
      executionId: trace0.id,
      stage: 'recommendation-ask-proposal-action',
      action: askAction,
    });
    const gateResult = step10.steps[9]!.result as Extract<
      typeof step10.steps[9]['result'],
      { stage: 'recommendation-ask-proposal-action' }
    >;
    expect(gateResult.gate).toBe('allowed');
    expect(gateResult.actionRequest).toMatchObject({
      actionKind: 'employee-messaging',
      authorityLevel: 'ASK',
      status: 'approved',
    });
    expect(gateResult.resolution).toBeNull();
    // The gated request really exists through the actions contract.
    const request = await getActionRequest(ctx, { requestId: gateResult.actionRequest!.id });
    expect(request.evaluation.outcome).toBe('allowed');

    // 11 — outcome: recorded on the execution, derived from the gate.
    const step11 = await runNextStage(ctx, {
      executionId: trace0.id,
      stage: 'outcome',
      summary: 'Mission closed at target confidence; validation question authorized.',
    });
    const outcomeResult = step11.steps[10]!.result as Extract<
      typeof step11.steps[10]['result'],
      { stage: 'outcome' }
    >;
    expect(outcomeResult.kind).toBe('action-authorized');
    expect(outcomeResult.actionRequestId).toBe(gateResult.actionRequest!.id);
    expect(step11.outcome).toMatchObject({
      kind: 'action-authorized',
      actionRequestId: gateResult.actionRequest!.id,
    });
    expect(step11.state).toBe('running'); // learning still follows

    // 12 — learning: evidence-backed knowledge captured through W010.
    const step12 = await runNextStage(ctx, {
      executionId: trace0.id,
      stage: 'learning',
      knowledge: {
        title: 'Q3 churn root cause: legacy-cohort pricing',
        summary: 'The Q3 churn rise is dominated by the pricing change applied to legacy cohorts.',
        topics: ['churn', 'pricing'],
      },
    });
    expect(step12.state).toBe('completed');
    expect(step12.completedStages).toBe(12);
    expect(step12.nextStage).toBeNull();
    expect(step12.completedAt).not.toBeNull();
    expect(step12.steps).toHaveLength(12);
    const learningResult = step12.steps[11]!.result as Extract<
      typeof step12.steps[11]['result'],
      { stage: 'learning' }
    >;
    expect(learningResult.knowledgeEntryId).not.toBeNull();
    // The outcome survived the learning stage's pointer advance.
    expect(step12.outcome).toMatchObject({ kind: 'action-authorized' });

    // Terminal: no further advance, no abandonment.
    await expectCode('invalid_transition', () =>
      runNextStage(ctx, { executionId: trace0.id, stage: 'learning', knowledge: null }),
    );
    await expectCode('invalid_transition', () =>
      abandonExecution(ctx, { executionId: trace0.id, reason: 'too late' }),
    );

    // §24 reconstructability: the trace carries the whole chain.
    const reloaded = await getExecution(ctx, { executionId: trace0.id });
    expect(reloaded.steps.map((step) => step.stageNumber)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    void competitorId;
  });

  it('rejects an observation stage that would ingest nothing', async () => {
    const ctx = member(tenantLoop);
    const trace = await startExecution(ctx, startInput());
    await expectCode('invalid_stage_input', () =>
      runNextStage(ctx, { executionId: trace.id, stage: 'observation' }),
    );
  });

  it('rejects foreign stage references uniformly (invalid_reference)', async () => {
    const ctx = member(tenantLoop);
    const foreignGoal = await seedGoal(member(tenantIso), 'foreign goal');
    const trace = await startExecution(ctx, startInput());

    await runNextStage(ctx, { executionId: trace.id, stage: 'observation', record: [observationIntake()] });
    await runNextStage(ctx, { executionId: trace.id, stage: 'evidence-memory' });
    await runNextStage(ctx, { executionId: trace.id, stage: 'world-update', update: null });

    await expectCode('invalid_reference', () =>
      runNextStage(ctx, {
        executionId: trace.id,
        stage: 'epistemic-evaluation',
        claims: [
          {
            proposition: 'Foreign evidence claim.',
            confidence: { value: 0.5, method: 'test' },
            evidenceObservationIds: [newId()],
          },
        ],
      }),
    );
    await runNextStage(ctx, { executionId: trace.id, stage: 'epistemic-evaluation', claims: [] });
    await expectCode('invalid_reference', () =>
      runNextStage(ctx, {
        executionId: trace.id,
        stage: 'goal-evaluation',
        relatedGoalIds: [foreignGoal],
      }),
    );
    await runNextStage(ctx, { executionId: trace.id, stage: 'goal-evaluation', relatedGoalIds: [] });
    await runNextStage(ctx, {
      executionId: trace.id,
      stage: 'unknown-mission-evaluation',
      unknowns: [],
      missions: [],
    });
    await expectCode('invalid_reference', () =>
      runNextStage(ctx, {
        executionId: trace.id,
        stage: 'knowledge-acquisition',
        missionId: newId(),
      }),
    );
  });
});

describe('the policy gate (W009 authority matrix at the action stage)', () => {
  it('suspends on approval_required and resumes on the human approval', async () => {
    const ctx = member(tenantGate);
    // Tenant policy: asking employees requires human approval at ASK.
    await setAuthorityPolicy(admin(tenantGate), {
      actionKind: 'employee-messaging',
      approvalLevels: ['ASK'],
    });

    const trace = await driveMinimal(ctx, (await startExecution(ctx, startInput())).id, 10);
    const executionId = trace.id;
    expect(trace.nextStage).toBe('recommendation-ask-proposal-action');

    const gated = await runNextStage(ctx, {
      executionId,
      stage: 'recommendation-ask-proposal-action',
      action: {
        actionKind: 'employee-messaging',
        authorityLevel: 'ASK',
        payload: { to: 'vp-cs', question: 'Why did churn rise?' },
        justification: 'mission-driven targeted question',
      },
    });
    expect(gated.state).toBe('awaiting_approval');
    expect(gated.completedStages).toBe(9);
    expect(gated.steps).toHaveLength(9);
    expect(gated.pending.requestId).not.toBeNull();

    // A pump while still pending returns the unchanged execution.
    const stillPending = await runNextStage(ctx, {
      executionId,
      stage: 'recommendation-ask-proposal-action',
    });
    expect(stillPending.state).toBe('awaiting_approval');
    expect(stillPending.steps).toHaveLength(9);

    // A human decides between pumps (a different principal — separation
    // of duties is the actions module's own gate).
    const decided = await decideApproval(approver(tenantGate), {
      requestId: gated.pending.requestId!,
      decision: 'approve',
      note: 'validated need',
    });
    expect(decided.status).toBe('approved');

    const resumed = await runNextStage(ctx, {
      executionId,
      stage: 'recommendation-ask-proposal-action',
    });
    expect(resumed.state).toBe('running');
    expect(resumed.completedStages).toBe(10);
    const gateResult = resumed.steps[9]!.result as Extract<
      typeof resumed.steps[9]['result'],
      { stage: 'recommendation-ask-proposal-action' }
    >;
    expect(gateResult.gate).toBe('approval_required');
    expect(gateResult.resolution).toBe('approved');
    expect(gateResult.actionRequest).toMatchObject({ status: 'approved' });

    const finished = await driveMinimal(ctx, executionId, 13);
    expect(finished.state).toBe('completed');
    expect(finished.outcome).toMatchObject({ kind: 'action-authorized' });
  });

  it('records a human rejection as action-refused and still completes the loop', async () => {
    const ctx = member(tenantGate);
    await setAuthorityPolicy(admin(tenantGate), {
      actionKind: 'employee-messaging',
      approvalLevels: ['ASK'],
    });
    const trace = await driveMinimal(ctx, (await startExecution(ctx, startInput())).id, 10);
    const gated = await runNextStage(ctx, {
      executionId: trace.id,
      stage: 'recommendation-ask-proposal-action',
      action: {
        actionKind: 'employee-messaging',
        authorityLevel: 'ASK',
        payload: { to: 'vp-cs', question: 'another question' },
      },
    });
    expect(gated.state).toBe('awaiting_approval');
    await decideApproval(approver(tenantGate), {
      requestId: gated.pending.requestId!,
      decision: 'reject',
      note: 'not now',
    });
    const resumed = await runNextStage(ctx, {
      executionId: trace.id,
      stage: 'recommendation-ask-proposal-action',
    });
    const gateResult = resumed.steps[9]!.result as Extract<
      typeof resumed.steps[9]['result'],
      { stage: 'recommendation-ask-proposal-action' }
    >;
    expect(gateResult.resolution).toBe('rejected');
    const finished = await driveMinimal(ctx, trace.id, 13);
    expect(finished.outcome).toMatchObject({ kind: 'action-refused' });
  });

  it('records a forbidden action as a policy refusal (the loop continues honestly)', async () => {
    const ctx = member(tenantForbidden);
    await setAuthorityPolicy(admin(tenantForbidden), {
      actionKind: 'employee-messaging',
      forbiddenLevels: ['ASK'],
    });
    const trace = await driveMinimal(ctx, (await startExecution(ctx, startInput())).id, 10);
    const stepped = await runNextStage(ctx, {
      executionId: trace.id,
      stage: 'recommendation-ask-proposal-action',
      action: {
        actionKind: 'employee-messaging',
        authorityLevel: 'ASK',
        payload: { to: 'vp-cs', question: 'forbidden question' },
      },
    });
    expect(stepped.state).toBe('running'); // no suspension: policy decided
    const gateResult = stepped.steps[9]!.result as Extract<
      typeof stepped.steps[9]['result'],
      { stage: 'recommendation-ask-proposal-action' }
    >;
    expect(gateResult.gate).toBe('forbidden');
    expect(gateResult.actionRequest).toMatchObject({ status: 'rejected' });
    const finished = await driveMinimal(ctx, trace.id, 13);
    expect(finished.outcome).toMatchObject({ kind: 'action-refused' });
    expect(finished.state).toBe('completed');
  });

  it('derives no-action when the cycle proposes nothing consequential', async () => {
    const ctx = member(tenantGate);
    const finished = await driveMinimal(ctx, (await startExecution(ctx, startInput())).id, 13);
    expect(finished.state).toBe('completed');
    expect(finished.outcome).toMatchObject({ kind: 'no-action', actionRequestId: null });
  });

  it('re-authorizes idempotently: the stable per-execution key never duplicates gate history', async () => {
    // tenantLoop carries no ASK policy row — the built-in default matrix
    // allows ASK, so the gate decides immediately.
    const ctx = member(tenantLoop);
    const executionId = (await startExecution(ctx, startInput())).id;
    await driveMinimal(ctx, executionId, 10);
    const proposal: ActionProposalInput = {
      actionKind: 'employee-messaging',
      authorityLevel: 'ASK',
      payload: { to: 'vp-cs', question: 'idempotent?' },
    };
    await runNextStage(ctx, {
      executionId,
      stage: 'recommendation-ask-proposal-action',
      action: proposal,
    });
    // The same key through the actions contract replays the same request.
    const direct = await authorizeAction(ctx, {
      actionKind: proposal.actionKind,
      authorityLevel: proposal.authorityLevel,
      payload: proposal.payload,
      idempotencyKey: `cognition:${executionId}:action`,
    });
    const trace = await getExecution(ctx, { executionId });
    const gateResult = trace.steps[9]!.result as Extract<
      typeof trace.steps[9]['result'],
      { stage: 'recommendation-ask-proposal-action' }
    >;
    expect(direct.id).toBe(gateResult.actionRequest!.id);
  });
});

describe('knowledge-acquisition resumability (lock 36)', () => {
  async function seedActiveMission(
    ctx: TenantContext,
    target: number,
  ): Promise<string> {
    const trace = await driveMinimal(ctx, (await startExecution(ctx, startInput())).id, 6);
    const stepped = await runNextStage(ctx, {
      executionId: trace.id,
      stage: 'unknown-mission-evaluation',
      missions: [
        {
          title: 'Below-target mission',
          knowledgeObjective: 'What drives churn?',
          informationValue: 0.7,
          urgency: 'medium',
          currentConfidence: 0.1,
          targetConfidence: target,
          investigationBudget: { amount: 100_00, currency: 'EUR' },
          rewardBudget: { amount: 0, currency: 'EUR' },
          candidateSources: [{ kind: 'system', label: 'billing-export' }],
          completionCriteria: 'confidence reached',
        },
      ],
    });
    const result = stepped.steps[5]!.result as Extract<
      typeof stepped.steps[5]['result'],
      { stage: 'unknown-mission-evaluation' }
    >;
    return result.missionIds[0]!;
  }

  it('revises the mission confidence below target on a weaker answer', async () => {
    const ctx = member(tenantAcq);
    const missionId = await seedActiveMission(ctx, 0.85);
    const execution = await startExecution(ctx, startInput());
    await driveMinimal(ctx, execution.id, 7);
    const suspended = await runNextStage(ctx, {
      executionId: execution.id,
      stage: 'knowledge-acquisition',
      missionId,
    });
    expect(suspended.state).toBe('awaiting_input');
    await recordAcquisitionOutcome(ctx, {
      planId: suspended.pending.planId!,
      outcome: 'answered',
      evidence: {
        payload: { partial: 'signal' },
        confidence: { value: 0.5, method: 'partial-analysis' },
      },
    });
    const resumed = await runNextStage(ctx, {
      executionId: execution.id,
      stage: 'knowledge-acquisition',
    });
    const result = resumed.steps[6]!.result as Extract<
      typeof resumed.steps[6]['result'],
      { stage: 'knowledge-acquisition' }
    >;
    expect(result.missionConfidence).toEqual({ from: 0.1, to: 0.5 });
    expect(result.missionCompleted).toBe(false);
    const mission = await getMission(ctx, missionId);
    expect(mission.content.status).toBe('active');
    expect(mission.content.currentConfidence).toBe(0.5);
  });

  it('records an unavailable acquisition without touching the mission confidence', async () => {
    const ctx = member(tenantAcq);
    const missionId = await seedActiveMission(ctx, 0.85);
    const execution = await startExecution(ctx, startInput());
    await driveMinimal(ctx, execution.id, 7);
    const suspended = await runNextStage(ctx, {
      executionId: execution.id,
      stage: 'knowledge-acquisition',
      missionId,
    });
    await recordAcquisitionOutcome(ctx, {
      planId: suspended.pending.planId!,
      outcome: 'unavailable',
      note: 'billing export down',
    });
    const resumed = await runNextStage(ctx, {
      executionId: execution.id,
      stage: 'knowledge-acquisition',
    });
    const result = resumed.steps[6]!.result as Extract<
      typeof resumed.steps[6]['result'],
      { stage: 'knowledge-acquisition' }
    >;
    expect(result.outcome).toMatchObject({ kind: 'unavailable', note: 'billing export down' });
    expect(result.missionConfidence).toBeNull();
    expect(result.missionCompleted).toBe(false);
  });

  it('completes the acquisition stage immediately when the cycle has no mission', async () => {
    const ctx = member(tenantAcq);
    const execution = await startExecution(ctx, startInput());
    await driveMinimal(ctx, execution.id, 7);
    const stepped = await runNextStage(ctx, {
      executionId: execution.id,
      stage: 'knowledge-acquisition',
      missionId: null,
    });
    expect(stepped.state).toBe('running');
    const result = stepped.steps[6]!.result as Extract<
      typeof stepped.steps[6]['result'],
      { stage: 'knowledge-acquisition' }
    >;
    expect(result.decision).toBe('no-mission');
    expect(result.missionId).toBeNull();
  });

  it('allows abandoning a suspended execution (terminal with a required reason)', async () => {
    const ctx = member(tenantAcq);
    const missionId = await seedActiveMission(ctx, 0.85);
    const execution = await startExecution(ctx, startInput());
    await driveMinimal(ctx, execution.id, 7);
    const suspended = await runNextStage(ctx, {
      executionId: execution.id,
      stage: 'knowledge-acquisition',
      missionId,
    });
    expect(suspended.state).toBe('awaiting_input');
    const abandoned = await abandonExecution(ctx, {
      executionId: execution.id,
      reason: 'mission deprioritized by management',
    });
    expect(abandoned.state).toBe('abandoned');
    expect(abandoned.abandonment).toMatchObject({ reason: 'mission deprioritized by management' });
    expect(abandoned.pending).toEqual({ planId: null, requestId: null });
    expect(abandoned.steps).toHaveLength(6);
    await expectCode('invalid_transition', () =>
      runNextStage(ctx, { executionId: execution.id, stage: 'knowledge-acquisition' }),
    );
  });
});

describe('append-only trace (storage-level audit guarantee)', () => {
  it('rejects UPDATE/DELETE/TRUNCATE on steps and DELETE/TRUNCATE on executions', async () => {
    const ctx = member(tenantAudit);
    const execution = await startExecution(ctx, startInput());
    await runNextStage(ctx, {
      executionId: execution.id,
      stage: 'observation',
      record: [observationIntake()],
    });
    const trace = await getExecution(ctx, { executionId: execution.id });
    const stepId = trace.steps[0]!.id;

    await expect(getDb().query(`UPDATE cognitive_execution_steps SET result = '{}' WHERE id = $1`, [stepId])).rejects.toThrow(/append-only/);
    await expect(getDb().query(`DELETE FROM cognitive_execution_steps WHERE id = $1`, [stepId])).rejects.toThrow(/append-only/);
    await expect(getDb().query(`TRUNCATE cognitive_execution_steps`)).rejects.toThrow(/append-only/);
    await expect(getDb().query(`DELETE FROM cognitive_executions WHERE id = $1`, [execution.id])).rejects.toThrow(/cannot be erased/);
    // Truncating the referenced table is blocked twice over: the FK from
    // the steps table and the erasure trigger.
    await expect(getDb().query(`TRUNCATE cognitive_executions`)).rejects.toThrow(/cannot be erased|cannot truncate/);
  });
});

describe('concurrency (the optimistic pointer guard)', () => {
  it('one of two racing pumps wins; the loser fails cleanly', async () => {
    const ctx = member(tenantConflict);
    const execution = await startExecution(ctx, startInput());
    await runNextStage(ctx, {
      executionId: execution.id,
      stage: 'observation',
      record: [observationIntake()],
    });
    const outcomes = await Promise.allSettled([
      runNextStage(ctx, { executionId: execution.id, stage: 'evidence-memory' }),
      runNextStage(ctx, { executionId: execution.id, stage: 'evidence-memory' }),
    ]);
    const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const codes = rejected.map((outcome) =>
      outcome.status === 'rejected' ? (outcome.reason as CognitionError).code : '',
    );
    expect(codes[0]).toMatch(/^(execution_conflict|stage_mismatch)$/);
    // Exactly one step for the stage exists.
    const trace = await getExecution(ctx, { executionId: execution.id });
    expect(trace.steps).toHaveLength(2);
    expect(trace.completedStages).toBe(2);
  });
});

describe('tenant isolation (ADR-0001)', () => {
  it('reports foreign executions uniformly as missing — reads, advances and abandonment', async () => {
    const owner = member(tenantIso);
    const foreign = member(tenantLoop);
    const execution = await startExecution(owner, startInput());

    await expectCode('execution_not_found', () =>
      getExecution(foreign, { executionId: execution.id }),
    );
    await expectCode('execution_not_found', () =>
      runNextStage(foreign, {
        executionId: execution.id,
        stage: 'observation',
        record: [observationIntake()],
      }),
    );
    await expectCode('execution_not_found', () =>
      abandonExecution(foreign, { executionId: execution.id, reason: 'foreign pump' }),
    );
    await expectCode('execution_not_found', () =>
      getExecutionStep(foreign, { executionId: execution.id, stage: 'observation' }),
    );
    // The owner proceeds unaffected.
    await runNextStage(owner, {
      executionId: execution.id,
      stage: 'observation',
      record: [observationIntake()],
    });
  });

  it('scopes listings to the calling tenant', async () => {
    const ctx = member(tenantList);
    const one = await startExecution(ctx, startInput());
    const two = await startExecution(ctx, startInput({ rationale: 'second' }));
    const other = await listExecutions(member(tenantIso), {});
    expect(other.map((execution) => execution.id)).not.toContain(one.id);

    const all = await listExecutions(ctx, {});
    expect(all.map((execution) => execution.id).sort()).toEqual([one.id, two.id].sort());

    const byCorrelation = await listExecutions(ctx, { correlationId: one.correlationId });
    expect(byCorrelation.map((execution) => execution.id)).toEqual([one.id]);

    const execution: CognitiveExecution = await startExecution(
      ctx,
      startInput({ trigger: { kind: 'management', label: 'COO request' } }),
    );
    const byTrigger = await listExecutions(ctx, { triggerKind: 'management' });
    expect(byTrigger.map((item) => item.id)).toEqual([execution.id]);
  });
});

describe('read surface', () => {
  it('deep-links one step by canonical stage', async () => {
    const ctx = member(tenantList);
    const execution = await startExecution(ctx, startInput());
    await runNextStage(ctx, {
      executionId: execution.id,
      stage: 'observation',
      record: [observationIntake()],
    });
    const step = await getExecutionStep(ctx, { executionId: execution.id, stage: 'observation' });
    expect(step.stage).toBe('observation');
    expect(step.stageNumber).toBe(1);
    expect(step.advancedByPrincipal).toBe(ctx.principalId);
    expect((step.result as { stage: string }).stage).toBe('observation');
    await expectCode('step_not_found', () =>
      getExecutionStep(ctx, { executionId: execution.id, stage: 'learning' }),
    );
    await expectCode('invalid_query', () =>
      getExecutionStep(ctx, { executionId: execution.id, stage: 'not-a-stage' } as never),
    );
  });

  it('rejects malformed queries and inputs', async () => {
    const ctx = member(tenantList);
    await expectCode('invalid_query', () => getExecution(ctx, { executionId: 'nope' } as never));
    await expectCode('invalid_query', () => listExecutions(ctx, { limit: 0 }));
    await expectCode('invalid_stage_input', () =>
      abandonExecution(ctx, { executionId: newId(), reason: '' }),
    );
    await expectCode('execution_not_found', () =>
      runNextStage(ctx, { executionId: newId(), stage: 'evidence-memory' }),
    );
  });

  it('validates stage payload shapes strictly (unknown keys rejected)', async () => {
    const ctx = member(tenantList);
    const execution = await startExecution(ctx, startInput());
    await expectCode('invalid_stage_input', () =>
      runNextStage(ctx, {
        executionId: execution.id,
        stage: 'observation',
        record: [observationIntake()],
        surprise: true,
      } as never),
    );
    await expectCode('invalid_stage_input', () =>
      runNextStage(ctx, {
        executionId: execution.id,
        stage: 'observation',
        record: [observationIntake({ big: 'x'.repeat(2_000_000) })],
      }),
    );
    // The action payload shape is validated at the action stage's turn.
    await driveMinimal(ctx, execution.id, 10);
    await expectCode('invalid_stage_input', () =>
      runNextStage(ctx, {
        executionId: execution.id,
        stage: 'recommendation-ask-proposal-action',
        action: { actionKind: 'Not A Slug', authorityLevel: 'ASK', payload: {} },
      }),
    );
  });
});
