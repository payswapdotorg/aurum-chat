// Integration tests for the attention module against the embedded
// PostgreSQL (PGlite, `:memory:`) through the db port. Covers the W051
// acceptance:
//
//  * UNPROMPTED: a driver/reading/standing gap is DERIVED from an active
//    goal + evidence readings — the input carries no question anywhere;
//    the unknown's question is the deterministic template.
//  * PROMOTION THROUGH THE CONTRACTS: a material candidate becomes an
//    epistemics unknown (subject the goal, evidence linked, note naming
//    the run) AND a missions mission (unknown linked, goal linked with
//    title label, urgency/confidences/information value carried over,
//    acquisition paths from the goal's evidence sources, run actor, run
//    budgets, deterministic completion criteria) — never a direct write.
//  * THE POLICY GATE: below-threshold candidates are recorded 'dismissed'
//    with NO unknown and NO mission; the run snapshots the thresholds it
//    applied; stricter policy demotes previously-material candidates.
//  * THE SEAM: proposals flow through the same validation, gate and audit
//    ('custom' gap kind, caller-supplied fields).
//  * CONTINUITY: a second pass over the same gap is 'already_covered'
//    while the mission is active; after the mission goes terminal the
//    returning need is a NEW unknown + mission (no duplicates, no
//    resurrection).
//  * EVIDENCE-LINKED AND AUDITABLE: readings must cite readable claims;
//    proposals' goals must be active; the originating cognitive execution
//    is validated; run + candidates are append-only (triggers reject
//    UPDATE/DELETE/TRUNCATE); every promotion is traceable.
//  * tenant isolation (ADR-0001) with uniform not-found semantics.
//  * the listing surfaces and the deep-linked candidate read.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { startExecution } from '@/modules/cognition/contract';
import { formBelief, getClaim, getUnknown, listUnknowns, recordClaim } from '@/modules/epistemics/contract';
import { createGoal, reviseGoal } from '@/modules/goals/contract';
import type { Goal } from '@/modules/goals/contract';
import { completeMission, getMission, listMissions } from '@/modules/missions/contract';
import { recordObservation } from '@/modules/observations/contract';
import { AttentionError } from '../errors';
import * as attentionContract from '../contract';
import type { DiscoveryRun, GapProposalInput, RunGoalGapDiscoveryInput } from '../types';
import { runMigrations } from '../../../../scripts/migrate';

const {
  getDiscoveryCandidate,
  getDiscoveryRun,
  listDiscoveryRuns,
  runGoalGapDiscovery,
} = attentionContract;

// Dedicated tenants keep each concern's data isolated from the others.
const tenantA = newId();
const tenantB = newId();
const tenantIso = newId();
const tenantOrigin = newId();
const tenantPolicy = newId();
const tenantContinuity = newId();
const tenantScope = newId();
const tenantConflict = newId();
const tenantStorage = newId();
const tenantList = newId();

const PERSON_ID = '0b2f8e2a-1c4b-4d8a-9f3e-7a2b6c5d4e8f';
const FAR_HORIZON = '2028-06-30T00:00:00.000Z';

function member(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: [] };
}

async function expectCode(code: string, fn: () => unknown): Promise<void> {
  try {
    await fn();
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(AttentionError);
    expect((error as AttentionError).code).toBe(code);
  }
}

/** Seeds one active goal through the goals contract. */
async function seedGoal(ctx: TenantContext, overrides: Record<string, unknown> = {}): Promise<Goal> {
  return createGoal(ctx, {
    title: 'Reduce monthly churn',
    objective: 'Bring churn under control',
    desiredState: 'Churn at or below 6 percent',
    metrics: [{ name: 'monthly-churn-rate', unit: 'percent', direction: 'at_most', threshold: 6 }],
    horizonEnd: FAR_HORIZON,
    owner: { kind: 'person', id: PERSON_ID, label: 'COO' },
    priority: 'critical',
    evidenceSources: [{ kind: 'source', label: 'Billing CRM' }],
    successCriteria: 'Churn at or below 6 percent for a full quarter',
    actor: { kind: 'person', id: PERSON_ID },
    rationale: 'W051 fixture',
    ...overrides,
  } as never);
}

/** Seeds one tenant-visible observation through the observations contract. */
async function seedObservation(ctx: TenantContext, payload: unknown): Promise<string> {
  const observation = await recordObservation(ctx, {
    kind: 'metric.sample',
    payload,
    observedAt: new Date().toISOString(),
    source: { kind: 'source', label: 'billing-crm' },
    channel: 'ingestion',
    confidence: { value: 0.85, method: 'test' },
  });
  return observation.id;
}

/** Seeds one claim citing one observation through the epistemics contract. */
async function seedClaim(ctx: TenantContext, proposition: string, observationId: string): Promise<string> {
  const claim = await recordClaim(ctx, {
    proposition,
    subject: { kind: 'goals.goal', id: '11111111-1111-4111-8111-111111111111' },
    confidence: { value: 0.85, method: 'test', basis: 'fixture' },
    evidenceObservationIds: [observationId],
    rationale: 'W051 fixture',
  });
  return claim.id;
}

/** Seeds one belief (the evidence basis for driver confidence) — returns its id. */
async function seedBelief(ctx: TenantContext, observationId: string): Promise<string> {
  const belief = await formBelief(ctx, {
    proposition: 'Pricing changes are the main churn driver',
    confidence: { value: 0.3, method: 'test', basis: 'fixture' },
    supportingObservationIds: [observationId],
    subject: { kind: 'goals.goal', id: '11111111-1111-4111-8111-111111111111' },
    validFrom: '2026-01-01T00:00:00.000Z',
    rationale: 'W051 fixture',
  });
  return belief.id;
}

/** A full run input, parameterized for the suites below. */
function runInput(overrides: Partial<RunGoalGapDiscoveryInput> = {}): RunGoalGapDiscoveryInput {
  return {
    trigger: { kind: 'scheduled', label: 'nightly goal-gap sweep' },
    originExecutionId: null,
    readings: [],
    proposals: [],
    investigationBudget: { amount: 500_00, currency: 'EUR' },
    rewardBudget: { amount: 100_00, currency: 'EUR' },
    actor: { kind: 'system', label: 'aurum-attention' },
    rationale: 'W051 fixture run',
    ...overrides,
  };
}

/** Seeds a goal + churn reading (8.4 vs at-most 6) and returns everything. */
async function seedOffTrackGap(ctx: TenantContext) {
  const goal = await seedGoal(ctx);
  const observationId = await seedObservation(ctx, { metric: 'monthly-churn-rate', value: 8.4 });
  const claimId = await seedClaim(ctx, 'Monthly churn rate is 8.4 percent', observationId);
  const reading = {
    goalId: goal.id,
    metricName: 'monthly-churn-rate',
    value: 8.4,
    evidenceClaimIds: [claimId],
  };
  return { goal, observationId, claimId, reading };
}

beforeAll(async () => {
  await runMigrations(getDb());
});

afterAll(async () => {
  await closeDb();
});

// ---------------------------------------------------------------------------
// The unprompted derivation, promoted through the sibling contracts
// ---------------------------------------------------------------------------

describe('runGoalGapDiscovery — derived gaps', () => {
  it('derives a driver gap with NO question supplied and promotes it to unknown + mission', async () => {
    const ctx = member(tenantA);
    const { goal, claimId, reading } = await seedOffTrackGap(ctx);

    const run = await runGoalGapDiscovery(ctx, runInput({ readings: [reading] }));

    expect(run.tenantId).toBe(tenantA);
    expect(run.counts).toEqual({ total: 1, promoted: 1, dismissed: 0, alreadyCovered: 0 });
    expect(run.policy).toEqual({ impactThreshold: 0.5, valueThreshold: 0.5 });
    const candidate = run.candidates[0]!;
    expect(candidate.source).toBe('derived');
    expect(candidate.gapKind).toBe('driver');
    expect(candidate.gapKey).toBe(`${goal.id}|driver|monthly-churn-rate`);
    // THE UNPROMPTED QUESTION — computed, never supplied (ADR-0017):
    expect(candidate.missingKnowledge).toBe(
      "What is driving monthly-churn-rate to 8.4 instead of at most 6 for goal 'Reduce monthly churn'?",
    );
    expect(candidate.consequence).toContain('cannot be steered back on track');
    expect(candidate.decisionImpact).toBe(0.7);
    expect(candidate.urgency).toBe('critical');
    expect(candidate.currentConfidence).toBe(0);
    expect(candidate.requiredConfidence).toBe(0.9);
    expect(candidate.informationValue).toBe(0.63);
    expect(candidate.evidenceClaimIds).toEqual([claimId]);
    expect(candidate.acquisitionPaths).toEqual([{ kind: 'system', id: null, label: 'Billing CRM' }]);
    expect(candidate.disposition).toBe('promoted');
    expect(candidate.missionId).not.toBeNull();
    expect(candidate.epistemicsUnknownId).not.toBeNull();

    // The epistemics unknown (W007), recorded through the contract:
    const unknown = await getUnknown(ctx, { unknownId: candidate.epistemicsUnknownId! });
    expect(unknown.status).toBe('open');
    expect(unknown.question).toBe(candidate.missingKnowledge);
    expect(unknown.consequence).toBe(candidate.consequence);
    expect(unknown.subject).toEqual({ kind: 'goals.goal', id: goal.id });
    expect(unknown.relatedClaimIds).toEqual([claimId]);
    expect(unknown.note).toContain(run.id);

    // The learning mission (W011), created through the contract:
    const mission = await getMission(ctx, candidate.missionId!);
    expect(mission.content.status).toBe('active');
    expect(mission.content.knowledgeObjective).toBe(candidate.missingKnowledge);
    expect(mission.content.unknownIds).toEqual([unknown.id]);
    expect(mission.content.affectedGoals).toEqual([{ goalId: goal.id, label: 'Reduce monthly churn' }]);
    expect(mission.content.urgency).toBe('critical');
    expect(mission.content.currentConfidence).toBe(0);
    expect(mission.content.targetConfidence).toBe(0.9);
    expect(mission.content.informationValue).toBe(0.63);
    expect(mission.content.investigationBudget).toEqual({ amount: 500_00, currency: 'EUR' });
    expect(mission.content.rewardBudget).toEqual({ amount: 100_00, currency: 'EUR' });
    expect(mission.content.candidateSources).toEqual([{ kind: 'system', id: null, label: 'Billing CRM' }]);
    expect(mission.content.completionCriteria).toContain('0.9');
    expect(mission.lastChange.actor).toEqual({ kind: 'system', id: null, label: 'aurum-attention' });
    expect(mission.lastChange.rationale).toContain(run.id);
  });

  it('derives a reading gap for an unevaluated metric and a standing gap for a metric-less goal', async () => {
    const ctx = member(tenantA);
    const goal = await seedGoal(ctx, {
      title: 'Onboarding quality',
      metrics: [
        { name: 'activation-rate', unit: 'percent', direction: 'at_least', threshold: 70 },
      ],
    });
    const brandGoal = await seedGoal(ctx, {
      title: 'Brand strength',
      metrics: [],
      priority: 'critical',
    });

    const run = await runGoalGapDiscovery(ctx, runInput());
    // activation-rate has no reading → reading gap; Brand has no metrics
    // and no standing confidence → standing gap; churn goal from the first
    // test shares the tenant — it has no reading either (its claim belongs
    // to another goal), so its metric also derives a reading gap.
    const kinds = run.candidates.map((c) => c.gapKind).sort();
    expect(kinds).toEqual(['reading', 'reading', 'standing']);

    const reading = run.candidates.find(
      (c) => c.affectedGoals[0]!.goalId === goal.id,
    )!;
    expect(reading.missingKnowledge).toBe(
      "What is the current value of activation-rate for goal 'Onboarding quality'?",
    );
    expect(reading.currentConfidence).toBe(0);
    expect(reading.decisionImpact).toBe(0.75); // critical, neutral severity

    const standing = run.candidates.find(
      (c) => c.affectedGoals[0]!.goalId === brandGoal.id,
    )!;
    expect(standing.gapKind).toBe('standing');
    expect(standing.missingKnowledge).toBe(
      "What is the current standing of goal 'Brand strength' relative to its desired state?",
    );
  });

  it('keeps the derived driver question when beliefs already bear on the drivers', async () => {
    const ctx = member(tenantA);
    const goal = await seedGoal(ctx, { title: 'Support load' });
    const observationId = await seedObservation(ctx, { metric: 'tickets', value: 160 });
    const claimId = await seedClaim(ctx, 'Weekly support tickets are 160', observationId);
    const beliefId = await seedBelief(ctx, observationId);

    // The gap is 0.7 · (0.9 − 0.3) = 0.42 of expected information value —
    // this pass sets the value threshold accordingly (policy is per run).
    const run = await runGoalGapDiscovery(ctx, runInput({
      goalIds: [goal.id],
      policy: { impactThreshold: 0.5, valueThreshold: 0.4 },
      readings: [{
        goalId: goal.id,
        metricName: 'monthly-churn-rate',
        value: 8.4,
        driverConfidence: 0.3,
        evidenceClaimIds: [claimId],
        evidenceBeliefIds: [beliefId],
      }],
    }));
    const candidate = run.candidates[0]!;
    expect(candidate.currentConfidence).toBe(0.3);
    expect(candidate.requiredConfidence).toBe(0.9);
    expect(candidate.informationValue).toBe(0.42); // 0.7 · 0.6
    expect(candidate.evidenceBeliefIds).toEqual([beliefId]);
    // the belief is linked onto the promoted unknown too
    const unknown = await getUnknown(ctx, { unknownId: candidate.epistemicsUnknownId! });
    expect(unknown.relatedBeliefIds).toEqual([beliefId]);
  });
});

// ---------------------------------------------------------------------------
// The policy gate
// ---------------------------------------------------------------------------

describe('runGoalGapDiscovery — the materiality policy gate', () => {
  it('dismisses below-threshold candidates with NO unknown and NO mission', async () => {
    const ctx = member(tenantPolicy);
    // low priority + off target → impact 0.25 · (0.5 + 0.5·0.4) = 0.15
    const goal = await seedGoal(ctx, { priority: 'low' });
    const observationId = await seedObservation(ctx, { metric: 'churn', value: 8.4 });
    const claimId = await seedClaim(ctx, 'Monthly churn rate is 8.4 percent', observationId);

    const run = await runGoalGapDiscovery(ctx, runInput({
      goalIds: [goal.id],
      readings: [{ goalId: goal.id, metricName: 'monthly-churn-rate', value: 8.4, evidenceClaimIds: [claimId] }],
    }));

    expect(run.counts).toEqual({ total: 1, promoted: 0, dismissed: 1, alreadyCovered: 0 });
    const candidate = run.candidates[0]!;
    expect(candidate.disposition).toBe('dismissed');
    expect(candidate.epistemicsUnknownId).toBeNull();
    expect(candidate.missionId).toBeNull();
    // no unknown was recorded for this goal
    const unknowns = await listUnknowns(ctx, { subjectKind: 'goals.goal', subjectId: goal.id });
    expect(unknowns).toHaveLength(0);
    // no mission exists for the goal either
    const missions = await listMissions(ctx, { affectedGoalId: goal.id });
    expect(missions).toHaveLength(0);
  });

  it('applies the run’s own thresholds — a stricter policy demotes a material gap', async () => {
    const ctx = member(tenantPolicy);
    const { goal, reading } = await seedOffTrackGap(ctx);

    const strict = await runGoalGapDiscovery(ctx, runInput({
      goalIds: [goal.id],
      readings: [reading],
      policy: { impactThreshold: 0.9, valueThreshold: 0.9 },
    }));
    expect(strict.policy).toEqual({ impactThreshold: 0.9, valueThreshold: 0.9 });
    expect(strict.counts.promoted).toBe(0);
    expect(strict.candidates[0]!.disposition).toBe('dismissed');

    // the same gap under the default policy promotes
    const lenient = await runGoalGapDiscovery(ctx, runInput({
      goalIds: [goal.id],
      readings: [reading],
    }));
    expect(lenient.counts.promoted).toBe(1);
  });

  it('rejects thresholds that are not a policy (zero) and out-of-range scores', async () => {
    const ctx = member(tenantPolicy);
    await expectCode('invalid_run_input', () =>
      runGoalGapDiscovery(ctx, runInput({ policy: { impactThreshold: 0 } })),
    );
    await expectCode('invalid_run_input', () =>
      runGoalGapDiscovery(ctx, runInput({ policy: { valueThreshold: 1.5 } })),
    );
  });
});

// ---------------------------------------------------------------------------
// The seam: proposals
// ---------------------------------------------------------------------------

describe('runGoalGapDiscovery — gap proposals (the LLM-may-propose seam)', () => {
  it('gates a proposal with the same policy and promotes it with caller-supplied fields', async () => {
    const ctx = member(tenantA);
    const goal = await seedGoal(ctx, { title: 'Churn' });
    const observationId = await seedObservation(ctx, { metric: 'churn', value: 8.4 });
    const claimId = await seedClaim(ctx, 'Monthly churn rate is 8.4 percent', observationId);

    // An on-track reading keeps the derivation quiet so ONLY the
    // proposal is decided in this pass.
    const onTrackObservationId = await seedObservation(ctx, { metric: 'churn', value: 5.1 });
    const onTrackClaimId = await seedClaim(ctx, 'Monthly churn rate is 5.1 percent', onTrackObservationId);

    const run = await runGoalGapDiscovery(ctx, runInput({
      goalIds: [goal.id],
      readings: [{ goalId: goal.id, metricName: 'monthly-churn-rate', value: 5.1, evidenceClaimIds: [onTrackClaimId] }],
      proposals: [{
        gapKey: 'churn-root-cause',
        affectedGoals: [{ goalId: goal.id, label: 'Churn (custom label)' }],
        missingKnowledge: 'Which customer segment drives the churn increase?',
        consequence: 'Retention spend cannot be targeted without the segment breakdown.',
        decisionImpact: 0.8,
        urgency: 'high',
        currentConfidence: 0.1,
        requiredConfidence: 0.85,
        informationValue: 0.6,
        evidenceClaimIds: [claimId],
        acquisitionPaths: [{ kind: 'person', label: 'Head of CX' }],
      }],
    }));

    expect(run.counts).toEqual({ total: 1, promoted: 1, dismissed: 0, alreadyCovered: 0 });
    const candidate = run.candidates[0]!;
    expect(candidate.source).toBe('proposed');
    expect(candidate.gapKind).toBe('custom');
    expect(candidate.gapKey).toBe('churn-root-cause');
    expect(candidate.disposition).toBe('promoted');

    const mission = await getMission(ctx, candidate.missionId!);
    // the proposal's label flows onto the mission's goal ref
    expect(mission.content.affectedGoals).toEqual([{ goalId: goal.id, label: 'Churn (custom label)' }]);
    expect(mission.content.urgency).toBe('high');
    expect(mission.content.targetConfidence).toBe(0.85);
    expect(mission.content.candidateSources).toEqual([{ kind: 'person', id: null, label: 'Head of CX' }]);
  });

  it('validates proposal invariants: goals active, confidence gap open, urgency vocabulary', async () => {
    const ctx = member(tenantA);
    const goal = await seedGoal(ctx, { title: 'Churn 2' });
    const base: GapProposalInput = {
      gapKey: 'x',
      affectedGoals: [{ goalId: goal.id }],
      missingKnowledge: 'q?',
      consequence: 'c',
      decisionImpact: 0.8,
      urgency: 'high',
      currentConfidence: 0.5,
      requiredConfidence: 0.9,
      informationValue: 0.6,
    };
    // closed gap
    await expectCode('invalid_proposal', () =>
      runGoalGapDiscovery(ctx, runInput({ proposals: [{ ...base, requiredConfidence: 0.5 }] })),
    );
    // bad urgency
    await expectCode('invalid_proposal', () =>
      proposalWithUrgency(ctx, base, 'urgent'),
    );
    // no goals
    await expectCode('invalid_proposal', () =>
      runGoalGapDiscovery(ctx, runInput({ proposals: [{ ...base, affectedGoals: [] }] })),
    );
    // unknown key
    await expectCode('invalid_proposal', () =>
      runGoalGapDiscovery(ctx, runInput({ proposals: [{ ...base, missionId: 'nope' } as never] })),
    );
  });

  /** Small helper: the base proposal with an overridden urgency. */
  async function proposalWithUrgency(
    ctx: TenantContext,
    base: GapProposalInput,
    urgency: string,
  ): Promise<unknown> {
    return runGoalGapDiscovery(ctx, runInput({ proposals: [{ ...base, urgency } as GapProposalInput] }));
  }
});

// ---------------------------------------------------------------------------
// Continuity: coverage, re-promotion, and the missions discipline
// ---------------------------------------------------------------------------

describe('runGoalGapDiscovery — continuous discovery', () => {
  it('marks a repeated gap already_covered while its mission is active, then re-promotes after it terminates', async () => {
    const ctx = member(tenantContinuity);
    const { goal, reading } = await seedOffTrackGap(ctx);

    const first = await runGoalGapDiscovery(ctx, runInput({ readings: [reading] }));
    expect(first.counts.promoted).toBe(1);
    const missionId = first.candidates[0]!.missionId!;

    // Second pass over the same gap: the mission is still active.
    const second = await runGoalGapDiscovery(ctx, runInput({ readings: [reading] }));
    expect(second.counts).toEqual({ total: 1, promoted: 0, dismissed: 0, alreadyCovered: 1 });
    const covered = second.candidates[0]!;
    expect(covered.coveredByMissionId).toBe(missionId);
    expect(covered.epistemicsUnknownId).toBeNull();
    expect(covered.missionId).toBeNull();
    // exactly one unknown and one mission exist for the goal so far
    expect(await listUnknowns(ctx, { subjectKind: 'goals.goal', subjectId: goal.id })).toHaveLength(1);
    expect(await listMissions(ctx, { affectedGoalId: goal.id })).toHaveLength(1);

    // The mission completes (terminal — the missions discipline).
    await completeMission(ctx, {
      missionId,
      achievedConfidence: 0.92,
      outcome: 'The driver was identified and addressed.',
      actor: { kind: 'system', label: 'aurum-attention' },
    });

    // Third pass: the gap re-opened (evidence still shows 8.4 with no
    // known drivers) → a NEW unknown and a NEW mission.
    const third = await runGoalGapDiscovery(ctx, runInput({ readings: [reading] }));
    expect(third.counts.promoted).toBe(1);
    const rePromoted = third.candidates[0]!;
    expect(rePromoted.epistemicsUnknownId).not.toBe(first.candidates[0]!.epistemicsUnknownId);
    expect(rePromoted.missionId).not.toBe(missionId);
    expect(await listUnknowns(ctx, { subjectKind: 'goals.goal', subjectId: goal.id })).toHaveLength(2);
    expect(await listMissions(ctx, { affectedGoalId: goal.id })).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Goal scope, origin execution, evidence links
// ---------------------------------------------------------------------------

describe('runGoalGapDiscovery — scope, origin and evidence validation', () => {
  it('scopes the pass to goalIds and rejects readings outside the scope', async () => {
    const ctx = member(tenantScope);
    const inScope = await seedGoal(ctx, { title: 'In scope' });
    const outOfScope = await seedGoal(ctx, { title: 'Out of scope' });
    const observationId = await seedObservation(ctx, { metric: 'churn', value: 8.4 });
    const claimId = await seedClaim(ctx, 'Monthly churn rate is 8.4 percent', observationId);

    const run = await runGoalGapDiscovery(ctx, runInput({
      goalIds: [inScope.id],
      readings: [{ goalId: inScope.id, metricName: 'monthly-churn-rate', value: 8.4, evidenceClaimIds: [claimId] }],
    }));
    expect(run.candidates.every((c) => c.affectedGoals[0]!.goalId === inScope.id)).toBe(true);

    await expectCode('invalid_goal_ref', () =>
      runGoalGapDiscovery(ctx, runInput({
        goalIds: [inScope.id],
        readings: [{ goalId: outOfScope.id, metricName: 'monthly-churn-rate', value: 8.4, evidenceClaimIds: [claimId] }],
      })),
    );
  });

  it('rejects readings for undeclared metrics and archived goals', async () => {
    const ctx = member(tenantScope);
    const goal = await seedGoal(ctx);
    const observationId = await seedObservation(ctx, { metric: 'churn', value: 8.4 });
    const claimId = await seedClaim(ctx, 'Monthly churn rate is 8.4 percent', observationId);

    await expectCode('invalid_reading', () =>
      runGoalGapDiscovery(ctx, runInput({
        goalIds: [goal.id],
        readings: [{ goalId: goal.id, metricName: 'not-a-declared-metric', value: 1, evidenceClaimIds: [claimId] }],
      })),
    );

    const archived = await seedGoal(ctx, { title: 'Archived' });
    await reviseGoal(ctx, {
      goalId: archived.id,
      status: 'archived',
      actor: { kind: 'person', id: PERSON_ID },
      rationale: 'done',
    });
    await expectCode('invalid_goal_ref', () =>
      runGoalGapDiscovery(ctx, runInput({ goalIds: [archived.id] })),
    );
  });

  it('validates the originating cognitive execution through the cognition contract', async () => {
    const ctx = member(tenantOrigin);
    const execution = await startExecution(ctx, {
      trigger: { kind: 'system', label: 'W051 fixture' },
      focus: { topics: ['churn'], entities: [] },
      actor: { kind: 'system', label: 'aurum-cognition' },
      rationale: 'W051 fixture',
    });

    const run = await runGoalGapDiscovery(ctx, runInput({
      trigger: { kind: 'cognitive-execution', label: 'goal-evaluation cycle' },
      originExecutionId: execution.id,
    }));
    expect(run.trigger).toEqual({ kind: 'cognitive-execution', label: 'goal-evaluation cycle' });
    expect(run.originExecutionId).toBe(execution.id);

    // a foreign-tenant execution is indistinguishable from a missing one
    const foreign = await startExecution(member(tenantB), {
      trigger: { kind: 'system', label: 'other tenant' },
      focus: { topics: ['churn'], entities: [] },
      actor: { kind: 'system', label: 'aurum-cognition' },
    });
    await expectCode('invalid_origin_ref', () =>
      runGoalGapDiscovery(ctx, runInput({ originExecutionId: foreign.id })),
    );
    await expectCode('invalid_origin_ref', () =>
      runGoalGapDiscovery(ctx, runInput({ originExecutionId: newId() })),
    );
    // a cognitive-execution trigger without the linkage is rejected
    await expectCode('invalid_run_input', () =>
      runGoalGapDiscovery(ctx, runInput({ trigger: { kind: 'cognitive-execution' } })),
    );
  });

  it('validates the evidence basis through the epistemics contract (uniform, no leak)', async () => {
    const ctx = member(tenantA);
    const goal = await seedGoal(ctx, { title: 'Churn 3' });
    const foreignCtx = member(tenantB);
    const foreignObservation = await seedObservation(foreignCtx, { metric: 'churn', value: 8.4 });
    const foreignClaim = await seedClaim(foreignCtx, 'Foreign churn reading', foreignObservation);

    // a claim of ANOTHER tenant is indistinguishable from a missing one
    await expectCode('invalid_evidence_ref', () =>
      runGoalGapDiscovery(ctx, runInput({
        goalIds: [goal.id],
        readings: [{ goalId: goal.id, metricName: 'monthly-churn-rate', value: 8.4, evidenceClaimIds: [foreignClaim] }],
      })),
    );
    await expectCode('invalid_evidence_ref', () =>
      runGoalGapDiscovery(ctx, runInput({
        goalIds: [goal.id],
        readings: [{ goalId: goal.id, metricName: 'monthly-churn-rate', value: 8.4, evidenceClaimIds: [newId()] }],
      })),
    );

    // claims in this tenant validate (round-trip through the contract)
    const observationId = await seedObservation(ctx, { metric: 'churn', value: 8.4 });
    const claimId = await seedClaim(ctx, 'Monthly churn rate is 8.4 percent', observationId);
    const claim = await getClaim(ctx, { claimId });
    expect(claim.evidenceObservationIds).toEqual([observationId]);
  });
});

// ---------------------------------------------------------------------------
// Conflicts and input validation
// ---------------------------------------------------------------------------

describe('runGoalGapDiscovery — conflicts and input shape', () => {
  it('rejects duplicate gap keys in one pass and persists nothing', async () => {
    const ctx = member(tenantConflict);
    const goal = await seedGoal(ctx);

    await expectCode('discovery_conflict', () =>
      runGoalGapDiscovery(ctx, runInput({
        proposals: [
          {
            gapKey: 'dup',
            affectedGoals: [{ goalId: goal.id }],
            missingKnowledge: 'q1?',
            consequence: 'c',
            decisionImpact: 0.9,
            urgency: 'high',
            currentConfidence: 0,
            requiredConfidence: 0.9,
            informationValue: 0.8,
          },
          {
            gapKey: 'dup',
            affectedGoals: [{ goalId: goal.id }],
            missingKnowledge: 'q2?',
            consequence: 'c',
            decisionImpact: 0.9,
            urgency: 'high',
            currentConfidence: 0,
            requiredConfidence: 0.9,
            informationValue: 0.8,
          },
        ],
      })),
    );
    expect(await listDiscoveryRuns(ctx, {})).toHaveLength(0);
  });

  it('rejects a proposal whose gap key collides with a derived one', async () => {
    const ctx = member(tenantConflict);
    const { goal, reading } = await seedOffTrackGap(ctx);
    const derivedKey = `${goal.id}|driver|monthly-churn-rate`;
    await expectCode('discovery_conflict', () =>
      runGoalGapDiscovery(ctx, runInput({
        readings: [reading],
        proposals: [{
          gapKey: derivedKey,
          affectedGoals: [{ goalId: goal.id }],
          missingKnowledge: 'q?',
          consequence: 'c',
          decisionImpact: 0.9,
          urgency: 'high',
          currentConfidence: 0,
          requiredConfidence: 0.9,
          informationValue: 0.8,
        }],
      })),
    );
  });

  it('validates the run input shape: unknown keys, budgets, actor, trigger', async () => {
    const ctx = member(tenantConflict);
    await expectCode('invalid_run_input', () =>
      runGoalGapDiscovery(ctx, runInput({ nope: true } as never)),
    );
    await expectCode('invalid_run_input', () =>
      runGoalGapDiscovery(ctx, runInput({ trigger: { kind: 'bogus' } as never })),
    );
    await expectCode('invalid_run_input', () =>
      runGoalGapDiscovery(ctx, runInput({ investigationBudget: { amount: -1, currency: 'EUR' } })),
    );
    await expectCode('invalid_run_input', () =>
      runGoalGapDiscovery(ctx, runInput({ investigationBudget: { amount: 10.5, currency: 'EUR' } })),
    );
    await expectCode('invalid_run_input', () =>
      runGoalGapDiscovery(ctx, runInput({ rewardBudget: { amount: 10, currency: 'euro' } })),
    );
    await expectCode('invalid_run_input', () =>
      runGoalGapDiscovery(ctx, runInput({ actor: { kind: 'system' } as never })),
    );
    await expectCode('invalid_context', () =>
      runGoalGapDiscovery({ tenantId: '', principalId: '', authority: [] }, runInput()),
    );
  });
});

// ---------------------------------------------------------------------------
// Storage discipline
// ---------------------------------------------------------------------------

describe('storage discipline (append-only)', () => {
  it('rejects UPDATE/DELETE on runs and candidates outright', async () => {
    const ctx = member(tenantStorage);
    const { reading } = await seedOffTrackGap(ctx);
    const run = await runGoalGapDiscovery(ctx, runInput({ readings: [reading] }));

    await expect(getDb().query(`UPDATE discovery_runs SET rationale = 'rewritten' WHERE tenant_id = $1`, [tenantStorage])).rejects.toThrow(/append-only/);
    await expect(getDb().query(`DELETE FROM discovery_runs WHERE tenant_id = $1`, [tenantStorage])).rejects.toThrow(/append-only/);
    await expect(
      getDb().query(`UPDATE discovery_candidates SET disposition = 'dismissed' WHERE tenant_id = $1 AND run_id = $2`, [tenantStorage, run.id]),
    ).rejects.toThrow(/append-only/);
    await expect(
      getDb().query(`DELETE FROM discovery_candidates WHERE tenant_id = $1`, [tenantStorage]),
    ).rejects.toThrow(/append-only/);
    await expect(getDb().query(`TRUNCATE discovery_candidates`)).rejects.toThrow(/append-only/);

    // the run view survived the attempted mutation untouched
    const after = await getDiscoveryRun(ctx, { runId: run.id });
    expect(after.counts.promoted).toBe(1);
    expect(after.candidates[0]!.disposition).toBe('promoted');
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation
// ---------------------------------------------------------------------------

describe('tenant isolation (ADR-0001)', () => {
  it('treats another tenant’s runs and candidates as missing', async () => {
    const ctx = member(tenantIso);
    const other = member(tenantB);
    const { reading } = await seedOffTrackGap(ctx);
    const run = await runGoalGapDiscovery(ctx, runInput({ readings: [reading] }));
    const candidate = run.candidates[0]!;

    await expectCode('run_not_found', () => getDiscoveryRun(other, { runId: run.id }));
    await expectCode('candidate_not_found', () => getDiscoveryCandidate(other, { candidateId: candidate.id }));
    // foreign reads return nothing
    expect(await listDiscoveryRuns(other, {})).toHaveLength(0);
    // a malformed id is a query error; a well-formed unknown id is uniformly not-found
    await expectCode('invalid_query', () => getDiscoveryRun(ctx, { runId: 'not-a-uuid' } as never));
    await expectCode('run_not_found', () => getDiscoveryRun(ctx, { runId: newId() }));
    await expectCode('candidate_not_found', () => getDiscoveryCandidate(ctx, { candidateId: newId() }));
  });
});

// ---------------------------------------------------------------------------
// Listing surfaces
// ---------------------------------------------------------------------------

describe('listing surfaces', () => {
  it('lists runs newest-first with counts, filters and deep links', async () => {
    const ctx = member(tenantList);
    const { goal, reading } = await seedOffTrackGoalForList(ctx);
    const run1 = await runGoalGapDiscovery(ctx, runInput({ readings: [reading] }));
    const run2 = await runGoalGapDiscovery(ctx, runInput({
      trigger: { kind: 'manual', label: 'operator pass' },
      readings: [reading], // already covered now
    }));

    const all = await listDiscoveryRuns(ctx, {});
    expect(all).toHaveLength(2);
    expect(all[0]!.id).toBe(run2.id); // newest first
    expect(all.map((r) => r.counts)).toEqual([
      { total: 1, promoted: 0, dismissed: 0, alreadyCovered: 1 },
      { total: 1, promoted: 1, dismissed: 0, alreadyCovered: 0 },
    ]);

    // filters
    expect((await listDiscoveryRuns(ctx, { triggerKind: 'manual' })).map((r) => r.id)).toEqual([run2.id]);
    expect((await listDiscoveryRuns(ctx, { disposition: 'promoted' })).map((r) => r.id)).toEqual([run1.id]);
    expect((await listDiscoveryRuns(ctx, { affectedGoalId: goal.id })).map((r) => r.id).sort()).toEqual([run1.id, run2.id].sort());
    expect((await listDiscoveryRuns(ctx, { limit: 1 })).map((r) => r.id)).toEqual([run2.id]);

    // the deep-link surfaces
    const deep = await getDiscoveryCandidate(ctx, { candidateId: run1.candidates[0]!.id });
    expect(deep.runId).toBe(run1.id);
    expect(deep.gapKind).toBe('driver');
    const full = await getDiscoveryRun(ctx, { runId: run2.id });
    expect(full.candidates[0]!.disposition).toBe('already_covered');
    expect(full.ranByPrincipal).toBe((full as DiscoveryRun).ranByPrincipal); // present on the view
    expect(full.trigger).toEqual({ kind: 'manual', label: 'operator pass' });
  });

  /** Seeds an off-track gap for the listing suite (fresh goal per run). */
  async function seedOffTrackGoalForList(ctx: TenantContext) {
    const goal = await seedGoal(ctx, { title: 'Listed churn goal' });
    const observationId = await seedObservation(ctx, { metric: 'churn', value: 8.4 });
    const claimId = await seedClaim(ctx, 'Monthly churn rate is 8.4 percent', observationId);
    const reading = { goalId: goal.id, metricName: 'monthly-churn-rate', value: 8.4, evidenceClaimIds: [claimId] };
    return { goal, reading };
  }
});
