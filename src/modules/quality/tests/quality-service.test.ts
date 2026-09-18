// Integration tests for the quality module against the embedded PostgreSQL
// (PGlite, `:memory:`) through the db port. Covers the W055 acceptance:
//
//  * METRICS FROM REAL RECORDS: one end-to-end flow seeds the entire
//    cognition stack through its contracts — goal → observation → claim →
//    goal-gap discovery (promoted candidate + launched mission) → mission
//    revision → two acquisition plans (ask-person first, then system) with
//    terminal outcomes → mission completion → settled learning outcome —
//    then computes ONE snapshot with all nine metric families and asserts
//    every payload: precision/recall against a recorded judgment,
//    first-choice source quality + employee routing accuracy, steps,
//    evidence quality, calibration, intervention success, realized value,
//    cost and time-to-useful-understanding.
//  * GROUND TRUTH IS RECORDED, NEVER INFERRED: judgments round-trip with
//    evaluator provenance; the discovery-candidate and acquisition-plan
//    references are validated through their contracts (foreign-tenant ids
//    are uniformly invalid_*_ref — no existence leak); corrections are new
//    rows and the latest one wins in the next snapshot.
//  * VERSIONED AND AUDITABLE: snapshots freeze the window, the canonical
//    metric-kind order, METRIC_SCHEMA_VERSION and the input audit
//    (considered counts, truncated flags); results deep-link by snapshot
//    id; UPDATE/DELETE/TRUNCATE are rejected by triggers on all three
//    tables; the listing surfaces filter as documented.
//  * METRICS DO NOT BECOME BUSINESS TRUTH: computing snapshots (and
//    recording judgments) leaves every source module's record set
//    untouched — the module is read-only over other modules by
//    construction, and this pins it.
//  * WINDOWS: candidates, plans, missions, outcomes and observations
//    outside the evaluation window are excluded from every family.
//  * tenant isolation (ADR-0001) with uniform not-found semantics.
//
// Time is deterministic: the whole suite pins the injectable service
// clock (src/infra/clock.ts) to controlled instants, so every recorded_at,
// settled_at, answered_at and completed_at used by the metric math is
// exact.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import { systemClock } from '@/infra/clock';
import type { TenantContext } from '@/infra/tenant';
import { startExecution } from '@/modules/cognition/contract';
import { recordClaim } from '@/modules/epistemics/contract';
import { createGoal, type Goal } from '@/modules/goals/contract';
import {
  IDENTITY_AUTHORITY_ATTEST,
  IDENTITY_AUTHORITY_LINK,
  attestIdentity,
  registerExternalIdentity,
} from '@/modules/identity/contract';
import {
  completeMission,
  createMission,
  listMissions,
  reviseMission,
  type CreateMissionInput,
  type MissionCandidateInput,
  type MissionCandidateKind,
} from '@/modules/missions/contract';
import { listObservations, recordObservation } from '@/modules/observations/contract';
import { createEmployee, createPerson, linkExternalIdentity } from '@/modules/people/contract';
import {
  defineOutcome,
  listMeasurements,
  listOutcomes,
  recordMeasurement,
  settleOutcome,
} from '@/modules/learning/contract';
import { listAcquisitionPlans, planNextAcquisition, recordAcquisitionOutcome } from '@/modules/knowledge-acquisition/contract';
import { listDiscoveryRuns, runGoalGapDiscovery } from '@/modules/attention/contract';
import { QualityError } from '../errors';
import * as qualityContract from '../contract';
import type {
  ComputeQualitySnapshotInput,
  InterventionSuccessPayload,
  InvestigationCostPayload,
  RecommendationCalibrationPayload,
  SourceSelectionPayload,
  TimeToUsefulUnderstandingPayload,
  UnknownDiscoveryPayload,
} from '../types';
import { runMigrations } from '../../../../scripts/migrate';

const {
  computeQualitySnapshot,
  getJudgment,
  getQualitySnapshot,
  listJudgments,
  listQualitySnapshots,
  recordJudgment,
} = qualityContract;

// Dedicated tenants keep each concern's data isolated from the others.
const tenantE2E = newId();
const tenantJudgments = newId();
const tenantList = newId();
const tenantWindow = newId();
const tenantTruth = newId();
const tenantIso = newId();
const tenantStranger = newId();
const tenantStorage = newId();
const tenantReads = newId();
const tenantEmpty = newId();
const tenantB = newId();

const PERSON_ID = '0b2f8e2a-1c4b-4d8a-9f3e-7a2b6c5d4e8f';
const RECOMMENDATION_ID = '7f9a5b3d-8c1e-4d4f-9e2b-3a5c7d9e1f3a';

// The deterministic clock plan (all instants are exact).
const T_BEFORE = '2026-09-01T00:00:00.000Z'; // before the evaluation window
const T_START = '2026-10-01T00:00:00.000Z'; // window start
const T_MID = '2026-10-15T12:00:00.000Z'; // in-window instants…
const T_END = '2026-11-01T00:00:00.000Z'; // window end

function at(iso: string): Date {
  return new Date(iso);
}

function member(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: [] };
}

function manager(tenantId: string): TenantContext {
  return {
    tenantId,
    principalId: newId(),
    authority: [IDENTITY_AUTHORITY_ATTEST, IDENTITY_AUTHORITY_LINK],
  };
}

async function expectCode(code: string, fn: () => unknown): Promise<void> {
  try {
    await fn();
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(QualityError);
    expect((error as QualityError).code).toBe(code);
  }
}

// ---------------------------------------------------------------------------
// Seeds (all through module contracts — never direct table writes)
// ---------------------------------------------------------------------------

let identityCounter = 0;

/** A person with an active employment and a verified linked identity. */
async function askableEmployee(ctx: TenantContext, fullName: string): Promise<string> {
  const person = await createPerson(ctx, { fullName });
  await createEmployee(ctx, { personId: person.id, title: `Title of ${fullName}` });
  identityCounter += 1;
  const registered = await registerExternalIdentity(ctx, {
    provider: 'slack',
    providerAccountId: `slack-quality-${identityCounter}`,
  });
  const attested = await attestIdentity(manager(ctx.tenantId), {
    identityId: registered.identity.id,
    evidence: `attestation for ${fullName}`,
  });
  await linkExternalIdentity(manager(ctx.tenantId), {
    personId: person.id,
    identityId: attested.id,
  });
  return person.id;
}

async function seedGoal(ctx: TenantContext): Promise<Goal> {
  return createGoal(ctx, {
    title: 'Reduce monthly churn',
    objective: 'Bring churn under control',
    desiredState: 'Churn at or below 6 percent',
    metrics: [{ name: 'monthly-churn-rate', unit: 'percent', direction: 'at_most', threshold: 6 }],
    horizonEnd: '2028-06-30T00:00:00.000Z',
    owner: { kind: 'person', id: PERSON_ID, label: 'COO' },
    priority: 'critical',
    evidenceSources: [{ kind: 'source', label: 'Billing CRM' }],
    successCriteria: 'Churn at or below 6 percent for a full quarter',
    actor: { kind: 'person', id: PERSON_ID },
    rationale: 'W055 fixture',
  } as never);
}

async function seedObservation(
  ctx: TenantContext,
  payload: unknown,
  observedAt: string,
  confidence = 0.85,
): Promise<string> {
  const observation = await recordObservation(ctx, {
    kind: 'metric.sample',
    payload,
    observedAt,
    source: { kind: 'source', label: 'billing-crm' },
    channel: 'ingestion',
    confidence: { value: confidence, method: 'test', basis: 'fixture' },
  });
  return observation.id;
}

async function seedClaim(ctx: TenantContext, proposition: string, observationId: string): Promise<string> {
  const claim = await recordClaim(ctx, {
    proposition,
    subject: { kind: 'goals.goal', id: '11111111-1111-4111-8111-111111111111' },
    confidence: { value: 0.85, method: 'test', basis: 'fixture' },
    evidenceObservationIds: [observationId],
    rationale: 'W055 fixture',
  });
  return claim.id;
}

function missionInput(overrides: Partial<CreateMissionInput> = {}): CreateMissionInput {
  return {
    title: 'Churn root cause',
    knowledgeObjective: 'Why did churn rise in Q3 and what is the dominant driver?',
    affectedGoals: [],
    unknownIds: [],
    informationValue: 0.8,
    urgency: 'high',
    currentConfidence: 0.1,
    targetConfidence: 0.85,
    investigationBudget: { amount: 500_00, currency: 'EUR' },
    rewardBudget: { amount: 50_00, currency: 'EUR' },
    rewardTerms: null,
    candidateSources: [],
    completionCriteria: 'A validated root-cause explanation with confidence >= 0.85.',
    actor: { kind: 'person', label: 'COO' },
    rationale: 'W055 fixture',
    ...overrides,
  };
}

/** Uniform signal vector for one menu candidate. */
function sig(
  kind: MissionCandidateKind,
  ref: { id?: string | null; label?: string | null },
  overrides: Record<string, unknown> = {},
  level = 0.5,
) {
  return {
    kind,
    id: ref.id ?? null,
    label: ref.label ?? null,
    relevance: level,
    reliability: level,
    freshness: level,
    authority: level,
    expectedQuality: level,
    priorContributionValue: level,
    cost: 0,
    access: 'allowed' as const,
    ...overrides,
  };
}

function snapshotInput(
  windowFrom: string,
  windowTo: string,
  overrides: Partial<ComputeQualitySnapshotInput> = {},
): ComputeQualitySnapshotInput {
  return {
    windowFrom,
    windowTo,
    metricKinds: [
      'unknown-discovery',
      'source-selection',
      'mission-resolution-efficiency',
      'evidence-quality',
      'recommendation-calibration',
      'intervention-success',
      'realized-value',
      'investigation-cost',
      'time-to-useful-understanding',
    ],
    originExecutionId: null,
    actor: { kind: 'system', label: 'aurum-quality' },
    rationale: 'W055 fixture snapshot',
    ...overrides,
  };
}

beforeAll(async () => {
  await runMigrations(getDb());
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await closeDb();
});

/** Pins the service clock to a fixed instant (deterministic recorded_at). */
function pinClock(iso: string): void {
  vi.spyOn(systemClock, 'now').mockReturnValue(at(iso));
}

// ---------------------------------------------------------------------------
// The end-to-end quality measurement flow (all nine families, real records)
// ---------------------------------------------------------------------------

describe('computeQualitySnapshot — the end-to-end flow over real cognition records', () => {
  it('measures all nine families from discovery through realized value', async () => {
    const ctx = member(tenantE2E);

    // -- Evidence + goal + unprompted discovery (W051), at a controlled instant.
    pinClock(T_MID);
    const goal = await seedGoal(ctx);
    const observationId = await seedObservation(ctx, { metric: 'monthly-churn-rate', value: 8.4 }, T_MID);
    const claimId = await seedClaim(ctx, 'Monthly churn rate is 8.4 percent', observationId);
    const run = await runGoalGapDiscovery(ctx, {
      trigger: { kind: 'scheduled', label: 'nightly goal-gap sweep' },
      goalIds: [goal.id],
      readings: [
        { goalId: goal.id, metricName: 'monthly-churn-rate', value: 8.4, evidenceClaimIds: [claimId] },
      ],
      investigationBudget: { amount: 500_00, currency: 'EUR' },
      rewardBudget: { amount: 50_00, currency: 'EUR' },
      actor: { kind: 'system', label: 'aurum-attention' },
      rationale: 'W055 fixture run',
    });
    expect(run.counts.promoted).toBe(1);
    const candidate = run.candidates[0]!;
    expect(candidate.disposition).toBe('promoted');
    expect(candidate.missionId).not.toBeNull();
    const missionId = candidate.missionId!;

    // -- The launched mission's menu gains an askable employee (W011/W002).
    const employeeId = await askableEmployee(ctx, 'Dana Director');
    const menu: MissionCandidateInput[] = [
      { kind: 'person', id: employeeId, label: 'Dana Director' },
      { kind: 'system', label: 'Billing CRM' },
    ];
    await reviseMission(ctx, {
      missionId,
      candidateSources: menu,
      actor: { kind: 'system', label: 'aurum-quality' },
      rationale: 'W055 fixture: widen the menu',
    });

    // -- First-choice acquisition: the employee, asked and answered (W012).
    pinClock('2026-10-15T14:00:00.000Z'); // +2h after creation
    const plan1 = await planNextAcquisition(ctx, {
      missionId,
      candidates: [
        sig('person', { id: employeeId }, { relevance: 0.95, expectedQuality: 0.9 }, 0.9),
        sig('system', { label: 'Billing CRM' }, { cost: 150 }, 0.5),
      ],
      actor: { kind: 'system', label: 'aurum-cognition' },
      rationale: 'W055 fixture plan 1',
    });
    expect(plan1.decision).toBe('selected');
    expect(plan1.action).toBe('ask-person');
    expect(plan1.estimatedCost).toBe(0);
    pinClock('2026-10-15T15:00:00.000Z'); // +3h
    await recordAcquisitionOutcome(ctx, {
      planId: plan1.id,
      outcome: 'answered',
      evidence: {
        payload: { answer: 'Pricing changes drove churn.' },
        confidence: { value: 0.8, method: 'source_trust', basis: 'direct account' },
      },
    });

    // -- Second acquisition: the system, unavailable (W012).
    pinClock('2026-10-15T16:00:00.000Z'); // +4h
    const plan2 = await planNextAcquisition(ctx, {
      missionId,
      candidates: [
        sig('person', { id: employeeId }, { relevance: 0.95, expectedQuality: 0.9 }, 0.9),
        sig('system', { label: 'Billing CRM' }, { cost: 150 }, 0.5),
      ],
      actor: { kind: 'system', label: 'aurum-cognition' },
      rationale: 'W055 fixture plan 2',
    });
    expect(plan2.decision).toBe('selected');
    expect(plan2.action).toBe('query-system');
    expect(plan2.estimatedCost).toBe(150);
    pinClock('2026-10-15T17:00:00.000Z'); // +5h
    await recordAcquisitionOutcome(ctx, {
      planId: plan2.id,
      outcome: 'unavailable',
      note: 'connector checkpoint stale',
    });

    // -- The mission resolves (W011) — 10h after creation.
    pinClock('2026-10-15T22:00:00.000Z'); // +10h
    await completeMission(ctx, {
      missionId,
      achievedConfidence: 0.9,
      outcome: 'Pricing changes are the dominant churn driver.',
      actor: { kind: 'system', label: 'aurum-cognition' },
    });

    // -- Extra evidence recorded in the window: one derived observation.
    await recordObservation(ctx, {
      kind: 'document.note',
      payload: { note: 'extracted churn context' },
      observedAt: '2026-10-16T09:00:00.000Z',
      source: { kind: 'agent', label: 'extraction' },
      channel: 'ingestion',
      lineage: { method: 'extraction', parents: [observationId], extractor: null },
      confidence: { value: 0.6, method: 'llm_extraction' },
    });

    // -- A settled recommendation outcome (W040): expected 12, realized 18.
    pinClock('2026-10-18T09:00:00.000Z');
    const outcome = await defineOutcome(ctx, {
      subject: { kind: 'recommendation', id: RECOMMENDATION_ID, label: 'Churn play' },
      metricName: 'retained accounts',
      metricUnit: 'accounts',
      direction: 'at_least',
      baseline: 10,
      expected: 12,
      horizon: '2027-03-31',
      affectedGoals: [{ goalId: goal.id, label: 'Q4 churn reduction' }],
      originExecutionId: null,
      actor: { kind: 'person', id: PERSON_ID },
      rationale: 'W055 fixture',
    });
    await recordMeasurement(ctx, {
      outcomeId: outcome.id,
      value: 18,
      note: 'quarter close',
      evidence: [{ kind: 'metric', label: 'billing-crm' }],
      actor: { kind: 'system', label: 'aurum-quality' },
    });
    const measurements = await listMeasurements(ctx, { outcomeId: outcome.id });
    await settleOutcome(ctx, {
      outcomeId: outcome.id,
      measurementId: measurements[0]!.id,
      actor: { kind: 'person', id: PERSON_ID },
    });

    // -- Ground truth judgments (quality-owned).
    pinClock('2026-10-20T09:00:00.000Z');
    await recordJudgment(ctx, {
      kind: 'unknown-consequentiality',
      gapKey: candidate.gapKey,
      candidateId: candidate.id,
      verdict: 'consequential',
      evaluator: { kind: 'person', id: PERSON_ID, label: 'COO' },
      note: 'the hidden driver was real',
    });
    await recordJudgment(ctx, {
      kind: 'source-selection',
      planId: plan1.id,
      verdict: 'correct',
      evaluator: { kind: 'person', id: PERSON_ID, label: 'COO' },
      note: 'Dana knew the answer',
    });

    // -- THE SNAPSHOT: one computation pass over the whole window.
    pinClock('2026-10-21T09:00:00.000Z');
    const snapshot = await computeQualitySnapshot(ctx, snapshotInput(T_START, T_END));

    expect(snapshot.tenantId).toBe(tenantE2E);
    expect(snapshot.windowFrom).toBe(T_START);
    expect(snapshot.windowTo).toBe(T_END);
    expect(snapshot.metricVersion).toBeGreaterThanOrEqual(1);
    expect(snapshot.metricKinds).toEqual(snapshotInput(T_START, T_END).metricKinds);
    expect(snapshot.originExecutionId).toBeNull();
    expect(snapshot.computedByPrincipal).toBe(ctx.principalId);
    expect(snapshot.inputs.truncated).toEqual([]);
    expect(snapshot.inputs.discoveryRunsConsidered).toBe(1);
    expect(snapshot.inputs.discoveryCandidatesConsidered).toBe(1);
    expect(snapshot.inputs.acquisitionPlansConsidered).toBe(2);
    expect(snapshot.inputs.missionsConsidered).toBe(1);
    expect(snapshot.inputs.outcomesConsidered).toBe(1);
    expect(snapshot.inputs.observationsConsidered).toBe(3);
    expect(snapshot.inputs.judgmentsConsidered).toBe(2);

    const byKind = new Map(snapshot.results.map((result) => [result.metricKind, result.payload]));

    // 1. Unknown-discovery precision/recall — the one promoted candidate,
    //    judged consequential, and the gap discovered.
    const unknown = byKind.get('unknown-discovery') as UnknownDiscoveryPayload;
    expect(unknown.promotedInWindow).toBe(1);
    expect(unknown.truePositives).toBe(1);
    expect(unknown.falsePositives).toBe(0);
    expect(unknown.unjudgedPromoted).toBe(0);
    expect(unknown.precision).toBe(1);
    expect(unknown.groundTruthConsequential).toBe(1);
    expect(unknown.discoveredConsequential).toBe(1);
    expect(unknown.missedConsequential).toBe(0);
    expect(unknown.recall).toBe(1);

    // 2. Source-selection — the employee was the first choice, answered,
    //    and judged correct.
    const selection = byKind.get('source-selection') as SourceSelectionPayload;
    expect(selection.firstChoiceTotal).toBe(1);
    expect(selection.firstChoiceResolved).toBe(1);
    expect(selection.firstChoiceAnswered).toBe(1);
    expect(selection.firstChoiceAnswerRate).toBe(1);
    expect(selection.judgedFirstChoice).toBe(1);
    expect(selection.correctFirstChoice).toBe(1);
    expect(selection.firstChoiceQualityRate).toBe(1);
    expect(selection.employeeFirstChoice).toBe(1);
    expect(selection.employeeJudged).toBe(1);
    expect(selection.employeeCorrect).toBe(1);
    expect(selection.employeeRoutingAccuracy).toBe(1);

    // 3. Mission resolution efficiency — two investigation steps.
    const efficiency = byKind.get('mission-resolution-efficiency') as {
      resolvedMissions: number;
      medianSteps: number | null;
      meanSteps: number | null;
    };
    expect(efficiency.resolvedMissions).toBe(1);
    expect(efficiency.medianSteps).toBe(2);
    expect(efficiency.meanSteps).toBe(2);

    // 4. Evidence quality — three observations in the window: the reading
    //    (0.85, with basis), the answer evidence the acquisition recorded
    //    (0.8, with basis) and the derived note (0.6, with lineage).
    const evidence = byKind.get('evidence-quality') as {
      observations: number;
      meanConfidence: number | null;
      shareWithLineage: number | null;
      shareWithConfidenceBasis: number | null;
    };
    expect(evidence.observations).toBe(3);
    expect(evidence.meanConfidence).toBe(0.75);
    expect(evidence.shareWithLineage).toBe(0.333333);
    expect(evidence.shareWithConfidenceBasis).toBe(0.666667);

    // 5. Recommendation calibration — expected 12, realized 18 (exceeded).
    const calibration = byKind.get('recommendation-calibration') as RecommendationCalibrationPayload;
    expect(calibration.settledRecommendations).toBe(1);
    expect(calibration.exceeded).toBe(1);
    expect(calibration.predictionBiasMean).toBe(6);
    expect(calibration.predictionErrorMean).toBe(6);
    expect(calibration.metOrExceededRate).toBe(1);

    // 6. Intervention success — one settled outcome, exceeded.
    const success = byKind.get('intervention-success') as InterventionSuccessPayload;
    expect(success.settled).toBe(1);
    expect(success.exceeded).toBe(1);
    expect(success.successRate).toBe(1);
    expect(success.bySubjectKind.recommendation?.exceeded).toBe(1);

    // 7. Realized value — expected 12, realized 18, improvement 8.
    const value = byKind.get('realized-value') as {
      settled: number;
      expectedValueSum: number;
      realizedValueSum: number;
      netVarianceSum: number;
      improvementSum: number;
    };
    expect(value.settled).toBe(1);
    expect(value.expectedValueSum).toBe(12);
    expect(value.realizedValueSum).toBe(18);
    expect(value.netVarianceSum).toBe(6);
    expect(value.improvementSum).toBe(8);

    // 8. Investigation cost — 150 EUR committed in window (the zero-cost
    //    employee ask + the 150-cost system query), 150 per resolved mission.
    const cost = byKind.get('investigation-cost') as InvestigationCostPayload;
    expect(cost.windowPlans).toBe(2);
    expect(cost.windowCostByCurrency).toEqual([{ currency: 'EUR', plans: 2, totalCost: 150 }]);
    expect(cost.resolvedMissions).toBe(1);
    expect(cost.costPerResolvedMissionByCurrency).toEqual([
      { currency: 'EUR', missions: 1, totalCost: 150, medianCost: 150, meanCost: 150 },
    ]);

    // 9. Time-to-useful-understanding — 10h to resolution, 3h to the
    //    first useful answer (mission created 12:00, answered 15:00).
    const timing = byKind.get('time-to-useful-understanding') as TimeToUsefulUnderstandingPayload;
    expect(timing.resolvedMissions).toBe(1);
    expect(timing.medianResolutionHours).toBe(10);
    expect(timing.meanResolutionHours).toBe(10);
    expect(timing.missionsWithFirstAnswer).toBe(1);
    expect(timing.medianTimeToFirstAnswerHours).toBe(3);
    expect(timing.meanTimeToFirstAnswerHours).toBe(3);
  });

  it('links the originating cognitive execution through the cognition contract', async () => {
    const ctx = member(tenantE2E);
    const execution = await startExecution(ctx, {
      trigger: { kind: 'management', label: 'W055 evaluation cycle' },
      focus: { topics: ['quality'], entities: [] },
      actor: { kind: 'system', label: 'cognition' },
      rationale: 'W055 fixture',
    });
    const snapshot = await computeQualitySnapshot(
      ctx,
      snapshotInput(T_START, T_END, {
        metricKinds: ['evidence-quality'],
        originExecutionId: execution.id,
      }),
    );
    expect(snapshot.originExecutionId).toBe(execution.id);
    expect(snapshot.metricKinds).toEqual(['evidence-quality']);
    expect(snapshot.results).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Judgments: recording, validation, cross-module references, reads
// ---------------------------------------------------------------------------

describe('recordJudgment — ground truth is recorded, never inferred', () => {
  it('round-trips an unknown-consequentiality judgment with evaluator provenance', async () => {
    const ctx = member(tenantJudgments);
    const judgment = await recordJudgment(ctx, {
      kind: 'unknown-consequentiality',
      gapKey: 'gap-1|driver|metric-a',
      windowFrom: T_START,
      windowTo: T_END,
      verdict: 'consequential',
      evaluator: { kind: 'person', id: PERSON_ID, label: 'COO' },
      note: 'the driver was real',
    });
    expect(judgment.tenantId).toBe(tenantJudgments);
    expect(judgment.kind).toBe('unknown-consequentiality');
    expect(judgment.gapKey).toBe('gap-1|driver|metric-a');
    expect(judgment.candidateId).toBeNull();
    expect(judgment.windowFrom).toBe(T_START);
    expect(judgment.windowTo).toBe(T_END);
    expect(judgment.verdict).toBe('consequential');
    expect(judgment.evaluator).toEqual({ kind: 'person', id: PERSON_ID, label: 'COO' });
    expect(judgment.recordedByPrincipal).toBe(ctx.principalId);
    expect(() => new Date(judgment.recordedAt)).not.toThrow();

    const deep = await getJudgment(ctx, { judgmentId: judgment.id });
    expect(deep).toEqual(judgment);
  });

  it('round-trips a source-selection judgment against a real plan', async () => {
    const ctx = member(tenantJudgments);
    pinClock(T_MID);
    const mission = await createMission(ctx, missionInput({ candidateSources: [{ kind: 'system', label: 'ERP' }] }));
    const plan = await planNextAcquisition(ctx, {
      missionId: mission.id,
      candidates: [sig('system', { label: 'ERP' })],
      actor: { kind: 'system', label: 'aurum-quality' },
    });
    const judgment = await recordJudgment(ctx, {
      kind: 'source-selection',
      planId: plan.id,
      verdict: 'incorrect',
      evaluator: { kind: 'agent', label: 'evaluator-agent' },
    });
    expect(judgment.kind).toBe('source-selection');
    expect(judgment.planId).toBe(plan.id);
    expect(judgment.verdict).toBe('incorrect');
    expect(judgment.windowFrom).toBeNull();
    expect(judgment.windowTo).toBeNull();
  });

  it('validates the discovery candidate through the attention contract', async () => {
    const ctx = member(tenantJudgments);
    // A real promoted candidate in THIS tenant.
    pinClock(T_MID);
    const goal = await seedGoal(ctx);
    const observationId = await seedObservation(ctx, { metric: 'monthly-churn-rate', value: 8.4 }, T_MID);
    const claimId = await seedClaim(ctx, 'Monthly churn rate is 8.4 percent', observationId);
    const run = await runGoalGapDiscovery(ctx, {
      trigger: { kind: 'manual', label: 'W055 judgment fixture' },
      goalIds: [goal.id],
      readings: [
        { goalId: goal.id, metricName: 'monthly-churn-rate', value: 8.4, evidenceClaimIds: [claimId] },
      ],
      investigationBudget: { amount: 500_00, currency: 'EUR' },
      rewardBudget: { amount: 50_00, currency: 'EUR' },
      actor: { kind: 'system', label: 'aurum-attention' },
    });
    const candidate = run.candidates[0]!;
    const judgment = await recordJudgment(ctx, {
      kind: 'unknown-consequentiality',
      gapKey: candidate.gapKey,
      candidateId: candidate.id,
      verdict: 'consequential',
      evaluator: { kind: 'person', label: 'reviewer' },
    });
    expect(judgment.candidateId).toBe(candidate.id);

    // Foreign-tenant and missing candidates are uniformly invalid.
    const foreignCtx = member(tenantB);
    const foreignGoal = await seedGoal(foreignCtx);
    const foreignObservation = await seedObservation(foreignCtx, { v: 1 }, T_MID);
    const foreignClaim = await seedClaim(foreignCtx, 'Foreign churn is 8.4', foreignObservation);
    const foreignRun = await runGoalGapDiscovery(foreignCtx, {
      trigger: { kind: 'manual', label: 'foreign' },
      goalIds: [foreignGoal.id],
      readings: [
        { goalId: foreignGoal.id, metricName: 'monthly-churn-rate', value: 8.4, evidenceClaimIds: [foreignClaim] },
      ],
      investigationBudget: { amount: 500_00, currency: 'EUR' },
      rewardBudget: { amount: 50_00, currency: 'EUR' },
      actor: { kind: 'system', label: 'aurum-attention' },
    });
    await expectCode('invalid_candidate_ref', () =>
      recordJudgment(ctx, {
        kind: 'unknown-consequentiality',
        gapKey: 'any-gap',
        candidateId: foreignRun.candidates[0]!.id,
        verdict: 'consequential',
        evaluator: { kind: 'person', label: 'reviewer' },
      }),
    );
    await expectCode('invalid_candidate_ref', () =>
      recordJudgment(ctx, {
        kind: 'unknown-consequentiality',
        gapKey: 'any-gap',
        candidateId: newId(),
        verdict: 'consequential',
        evaluator: { kind: 'person', label: 'reviewer' },
      }),
    );
  });

  it('validates the acquisition plan through the knowledge-acquisition contract', async () => {
    const ctx = member(tenantJudgments);
    await expectCode('invalid_plan_ref', () =>
      recordJudgment(ctx, {
        kind: 'source-selection',
        planId: newId(),
        verdict: 'correct',
        evaluator: { kind: 'person', label: 'reviewer' },
      }),
    );
    // A malformed plan id never reaches the cross-module check at all
    // (the learning module's malformed-origin precedent).
    await expectCode('invalid_judgment_input', () =>
      recordJudgment(ctx, {
        kind: 'source-selection',
        planId: 'not-a-uuid',
        verdict: 'correct',
        evaluator: { kind: 'person', label: 'reviewer' },
      }),
    );
  });

  it('rejects malformed judgment inputs at the contract boundary', async () => {
    const ctx = member(tenantJudgments);
    await expectCode('invalid_judgment_input', () =>
      recordJudgment(ctx, {
        kind: 'unknown-consequentiality',
        gapKey: 'gap',
        verdict: 'correct', // wrong verdict vocabulary for the kind
        evaluator: { kind: 'person', label: 'reviewer' },
      } as never),
    );
    await expectCode('invalid_judgment_input', () =>
      recordJudgment(ctx, {
        kind: 'source-selection',
        planId: null,
        verdict: 'correct',
        evaluator: { kind: 'person', label: 'reviewer' },
      } as never),
    );
    await expectCode('invalid_judgment_input', () =>
      recordJudgment(ctx, {
        kind: 'unknown-consequentiality',
        gapKey: 'gap',
        windowFrom: T_END,
        windowTo: T_START, // inverted window
        verdict: 'consequential',
        evaluator: { kind: 'person', label: 'reviewer' },
      }),
    );
    await expectCode('invalid_judgment_input', () =>
      recordJudgment(ctx, {
        kind: 'unknown-consequentiality',
        gapKey: 'gap',
        verdict: 'consequential',
        evaluator: { kind: 'vendor' },
      } as never),
    );
    await expectCode('invalid_judgment_input', () =>
      recordJudgment(ctx, {
        kind: 'unknown-consequentiality',
        gapKey: 'gap',
        verdict: 'consequential',
        evaluator: { kind: 'person', label: 'reviewer' },
        malicious: 'unknown key',
      } as never),
    );
    await expectCode('invalid_context', () =>
      recordJudgment({ tenantId: '', principalId: 'p', authority: [] } as never, {
        kind: 'unknown-consequentiality',
        gapKey: 'gap',
        verdict: 'consequential',
        evaluator: { kind: 'person', label: 'reviewer' },
      }),
    );
  });

  it('lists judgments by kind, gapKey and planId, newest first', async () => {
    const ctx = member(tenantList);
    pinClock('2026-10-02T00:00:00.000Z');
    const first = await recordJudgment(ctx, {
      kind: 'unknown-consequentiality',
      gapKey: 'list-gap-a',
      verdict: 'consequential',
      evaluator: { kind: 'person', label: 'reviewer' },
    });
    pinClock('2026-10-03T00:00:00.000Z');
    const second = await recordJudgment(ctx, {
      kind: 'unknown-consequentiality',
      gapKey: 'list-gap-b',
      verdict: 'not_consequential',
      evaluator: { kind: 'person', label: 'reviewer' },
    });
    // A correction: the newest judgment for list-gap-a wins in computation.
    pinClock('2026-10-04T00:00:00.000Z');
    const correction = await recordJudgment(ctx, {
      kind: 'unknown-consequentiality',
      gapKey: 'list-gap-a',
      verdict: 'not_consequential',
      evaluator: { kind: 'person', label: 'reviewer' },
      note: 'on reflection, immaterial',
    });

    const all = await listJudgments(ctx, {});
    expect(all.map((judgment) => judgment.id)).toEqual([correction.id, second.id, first.id]);

    const byGap = await listJudgments(ctx, { gapKey: 'list-gap-a' });
    expect(byGap.map((judgment) => judgment.id)).toEqual([correction.id, first.id]);

    const byKind = await listJudgments(ctx, { kind: 'source-selection' });
    expect(byKind).toEqual([]);
    expect((await listJudgments(ctx, { kind: 'unknown-consequentiality' })).length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Windows: out-of-window records are excluded from every family
// ---------------------------------------------------------------------------

describe('computeQualitySnapshot — the evaluation window bounds every family', () => {
  it('excludes records outside the window and applies judgment windows', async () => {
    const ctx = member(tenantWindow);

    // A promoted discovery run BEFORE the window.
    pinClock(T_BEFORE);
    const goal = await seedGoal(ctx);
    const oldObservation = await seedObservation(ctx, { metric: 'monthly-churn-rate', value: 8.4 }, T_BEFORE);
    const oldClaim = await seedClaim(ctx, 'Churn was 8.4 before the window', oldObservation);
    const oldRun = await runGoalGapDiscovery(ctx, {
      trigger: { kind: 'scheduled', label: 'before the window' },
      goalIds: [goal.id],
      readings: [
        { goalId: goal.id, metricName: 'monthly-churn-rate', value: 8.4, evidenceClaimIds: [oldClaim] },
      ],
      investigationBudget: { amount: 500_00, currency: 'EUR' },
      rewardBudget: { amount: 50_00, currency: 'EUR' },
      actor: { kind: 'system', label: 'aurum-attention' },
    });
    const oldCandidate = oldRun.candidates[0]!;
    const oldMissionId = oldCandidate.missionId!;

    // A promoted discovery run IN the window (fresh mission after the old
    // one resolves — a returning need is a new unknown + mission). The old
    // mission completes BEFORE the window.
    pinClock('2026-09-15T00:00:00.000Z');
    await completeMission(ctx, {
      missionId: oldMissionId,
      achievedConfidence: 0.9,
      outcome: 'Resolved before the window.',
      actor: { kind: 'system', label: 'aurum-quality' },
    });
    pinClock(T_MID);
    const freshObservation = await seedObservation(ctx, { metric: 'monthly-churn-rate', value: 8.1 }, T_MID);
    const freshClaim = await seedClaim(ctx, 'Churn is 8.1 in the window', freshObservation);
    const freshRun = await runGoalGapDiscovery(ctx, {
      trigger: { kind: 'scheduled', label: 'in the window' },
      goalIds: [goal.id],
      readings: [
        { goalId: goal.id, metricName: 'monthly-churn-rate', value: 8.1, evidenceClaimIds: [freshClaim] },
      ],
      investigationBudget: { amount: 500_00, currency: 'EUR' },
      rewardBudget: { amount: 50_00, currency: 'EUR' },
      actor: { kind: 'system', label: 'aurum-attention' },
    });
    const freshCandidate = freshRun.candidates[0]!;
    expect(freshCandidate.disposition).toBe('promoted');

    // Ground truth: the gap was consequential only DURING the window.
    await recordJudgment(ctx, {
      kind: 'unknown-consequentiality',
      gapKey: freshCandidate.gapKey,
      verdict: 'consequential',
      windowFrom: T_START,
      windowTo: T_END,
      evaluator: { kind: 'person', label: 'reviewer' },
    });
    // …and an unjudged-time judgment that a LATER window will see.
    await recordJudgment(ctx, {
      kind: 'unknown-consequentiality',
      gapKey: 'late-gap',
      verdict: 'consequential',
      evaluator: { kind: 'person', label: 'reviewer' },
    });

    const snapshot = await computeQualitySnapshot(
      ctx,
      snapshotInput(T_START, T_END, {
        metricKinds: ['unknown-discovery', 'mission-resolution-efficiency', 'evidence-quality'],
      }),
    );
    const byKind = new Map(snapshot.results.map((result) => [result.metricKind, result.payload]));

    // Only the in-window promotion counts; the in-window mission is still
    // active, so no resolution metrics from the old one (completed before
    // the window).
    const unknown = byKind.get('unknown-discovery') as UnknownDiscoveryPayload;
    expect(unknown.promotedInWindow).toBe(1);
    expect(unknown.truePositives).toBe(1);
    expect(unknown.precision).toBe(1);
    // The unbounded 'late-gap' judgment also applies to THIS window
    // (unqualified statements of fact): it is ground truth and missed.
    expect(unknown.groundTruthConsequential).toBe(2);
    expect(unknown.discoveredConsequential).toBe(1);
    expect(unknown.missedConsequential).toBe(1);
    expect(unknown.recall).toBe(0.5);

    const efficiency = byKind.get('mission-resolution-efficiency') as { resolvedMissions: number };
    expect(efficiency.resolvedMissions).toBe(0);

    // Observations observed before the window are excluded by the query.
    const evidence = byKind.get('evidence-quality') as { observations: number };
    expect(evidence.observations).toBeGreaterThanOrEqual(1);

    // A later window sees the unbounded 'late-gap' ground truth as missed.
    const later = await computeQualitySnapshot(
      ctx,
      snapshotInput('2026-11-02T00:00:00.000Z', '2026-12-01T00:00:00.000Z', {
        metricKinds: ['unknown-discovery'],
      }),
    );
    const laterUnknown = later.results[0]!.payload as UnknownDiscoveryPayload;
    expect(laterUnknown.promotedInWindow).toBe(0);
    expect(laterUnknown.groundTruthConsequential).toBe(1); // the unbounded judgment
    expect(laterUnknown.missedConsequential).toBe(1);
    expect(laterUnknown.recall).toBe(0);
    expect(laterUnknown.precision).toBeNull(); // nothing promoted → no judgments applied
  });
});

// ---------------------------------------------------------------------------
// Metrics do not become business truth (read-only over other modules)
// ---------------------------------------------------------------------------

describe('quality measurement does not become business truth', () => {
  it('computing snapshots and recording judgments mutates no other module state', async () => {
    const ctx = member(tenantTruth);
    pinClock(T_MID);
    const goal = await seedGoal(ctx);
    const observationId = await seedObservation(ctx, { metric: 'monthly-churn-rate', value: 8.4 }, T_MID);
    const claimId = await seedClaim(ctx, 'Churn 8.4', observationId);
    const run = await runGoalGapDiscovery(ctx, {
      trigger: { kind: 'scheduled', label: 'truth fixture' },
      goalIds: [goal.id],
      readings: [
        { goalId: goal.id, metricName: 'monthly-churn-rate', value: 8.4, evidenceClaimIds: [claimId] },
      ],
      investigationBudget: { amount: 500_00, currency: 'EUR' },
      rewardBudget: { amount: 50_00, currency: 'EUR' },
      actor: { kind: 'system', label: 'aurum-attention' },
    });

    const before = {
      missions: (await listMissions(ctx, { limit: 500 })).length,
      plans: (await listAcquisitionPlans(ctx, { limit: 500 })).length,
      outcomes: (await listOutcomes(ctx, { limit: 500 })).length,
      observations: (await listObservations(ctx, { limit: 500 })).length,
      runs: (await listDiscoveryRuns(ctx, { limit: 500 })).length,
    };

    const first = await computeQualitySnapshot(ctx, snapshotInput(T_START, T_END));
    await recordJudgment(ctx, {
      kind: 'unknown-consequentiality',
      gapKey: run.candidates[0]!.gapKey,
      verdict: 'consequential',
      evaluator: { kind: 'person', label: 'reviewer' },
    });
    const second = await computeQualitySnapshot(ctx, snapshotInput(T_START, T_END));

    const nowCounts = {
      missions: (await listMissions(ctx, { limit: 500 })).length,
      plans: (await listAcquisitionPlans(ctx, { limit: 500 })).length,
      outcomes: (await listOutcomes(ctx, { limit: 500 })).length,
      observations: (await listObservations(ctx, { limit: 500 })).length,
      runs: (await listDiscoveryRuns(ctx, { limit: 500 })).length,
    };
    expect(nowCounts).toEqual(before);

    // The metrics themselves DO move when ground truth arrives — that is
    // their job — while the business records stay untouched.
    const firstUnknown = (await getQualitySnapshot(ctx, { snapshotId: first.id })).results.find(
      (result) => result.metricKind === 'unknown-discovery',
    )!.payload as UnknownDiscoveryPayload;
    const secondUnknown = (await getQualitySnapshot(ctx, { snapshotId: second.id })).results.find(
      (result) => result.metricKind === 'unknown-discovery',
    )!.payload as UnknownDiscoveryPayload;
    expect(firstUnknown.unjudgedPromoted).toBe(1);
    expect(firstUnknown.precision).toBeNull();
    expect(secondUnknown.truePositives).toBe(1);
    expect(secondUnknown.precision).toBe(1);
    expect(second.inputs.judgmentsConsidered).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Snapshot validation, reads and the empty tenant
// ---------------------------------------------------------------------------

describe('computeQualitySnapshot — validation and reads', () => {
  it('rejects malformed snapshot inputs', async () => {
    const ctx = member(tenantReads);
    await expectCode('invalid_snapshot_input', () =>
      computeQualitySnapshot(ctx, snapshotInput(T_END, T_START)), // inverted window
    );
    await expectCode('invalid_snapshot_input', () =>
      computeQualitySnapshot(ctx, snapshotInput(T_START, T_START)), // empty window
    );
    await expectCode('invalid_snapshot_input', () =>
      computeQualitySnapshot(ctx, snapshotInput('2026-10-01', T_END)), // not an instant
    );
    await expectCode('invalid_snapshot_input', () =>
      computeQualitySnapshot(ctx, snapshotInput(T_START, T_END, { metricKinds: [] })),
    );
    await expectCode('invalid_snapshot_input', () =>
      computeQualitySnapshot(ctx, snapshotInput(T_START, T_END, { metricKinds: ['nope'] as never })),
    );
    await expectCode('invalid_snapshot_input', () =>
      computeQualitySnapshot(ctx, {
        ...snapshotInput(T_START, T_END),
        surprise: 'unknown key',
      } as never),
    );
    await expectCode('invalid_snapshot_input', () =>
      computeQualitySnapshot(ctx, snapshotInput(T_START, T_END, { originExecutionId: 'nope' })),
    );
  });

  it('validates the originating execution and rejects foreign ones uniformly', async () => {
    const ctx = member(tenantReads);
    const foreign = await startExecution(member(tenantIso), {
      trigger: { kind: 'management', label: 'foreign execution' },
      focus: { topics: ['isolation'], entities: [] },
      actor: { kind: 'system', label: 'cognition' },
      rationale: 'W055 isolation fixture',
    });
    await expectCode('invalid_origin_ref', () =>
      computeQualitySnapshot(ctx, snapshotInput(T_START, T_END, { originExecutionId: foreign.id })),
    );
    await expectCode('invalid_origin_ref', () =>
      computeQualitySnapshot(ctx, snapshotInput(T_START, T_END, { originExecutionId: newId() })),
    );
  });

  it('stores results in canonical order and deep-links them', async () => {
    const ctx = member(tenantReads);
    const snapshot = await computeQualitySnapshot(
      ctx,
      snapshotInput(T_START, T_END, {
        // Deliberately non-canonical request order:
        metricKinds: ['realized-value', 'unknown-discovery', 'evidence-quality'],
      }),
    );
    expect(snapshot.metricKinds).toEqual(['unknown-discovery', 'evidence-quality', 'realized-value']);
    expect(snapshot.results.map((result) => result.metricKind)).toEqual([
      'unknown-discovery',
      'evidence-quality',
      'realized-value',
    ]);

    const deep = await getQualitySnapshot(ctx, { snapshotId: snapshot.id });
    expect(deep.id).toBe(snapshot.id);
    expect(deep.results).toEqual(snapshot.results);

    // The list surface filters by contained metric family, newest first.
    const containing = await listQualitySnapshots(ctx, { metricKind: 'evidence-quality' });
    expect(containing.map((summary) => summary.id)).toContain(snapshot.id);
    const excluding = await listQualitySnapshots(ctx, { metricKind: 'investigation-cost' });
    expect(excluding.map((summary) => summary.id)).not.toContain(snapshot.id);

    await expectCode('invalid_snapshot_query', () => getQualitySnapshot(ctx, { snapshotId: 'nope' }));
    await expectCode('invalid_snapshot_query', () => listQualitySnapshots(ctx, { limit: 0 }));
    await expectCode('invalid_judgment_query', () => getJudgment(ctx, { judgmentId: 'nope' }));
  });

  it('computes an honest all-empty snapshot for a tenant with no records', async () => {
    const ctx = member(tenantEmpty);
    const snapshot = await computeQualitySnapshot(ctx, snapshotInput(T_START, T_END));
    const byKind = new Map(snapshot.results.map((result) => [result.metricKind, result.payload]));
    expect(snapshot.inputs).toEqual({
      discoveryRunsConsidered: 0,
      discoveryCandidatesConsidered: 0,
      acquisitionPlansConsidered: 0,
      missionsConsidered: 0,
      outcomesConsidered: 0,
      observationsConsidered: 0,
      judgmentsConsidered: 0,
      truncated: [],
    });
    expect(byKind.get('unknown-discovery')).toMatchObject({ precision: null, recall: null });
    expect(byKind.get('source-selection')).toMatchObject({ firstChoiceQualityRate: null });
    expect(byKind.get('mission-resolution-efficiency')).toMatchObject({ medianSteps: null });
    expect(byKind.get('evidence-quality')).toMatchObject({ meanConfidence: null });
    expect(byKind.get('recommendation-calibration')).toMatchObject({ predictionBiasMean: null });
    expect(byKind.get('intervention-success')).toMatchObject({ successRate: null });
    expect(byKind.get('realized-value')).toMatchObject({ realizedValueSum: 0 });
    expect(byKind.get('investigation-cost')).toMatchObject({
      windowCostByCurrency: [],
      costPerResolvedMissionByCurrency: [],
    });
    expect(byKind.get('time-to-useful-understanding')).toMatchObject({ medianResolutionHours: null });
  });
});

// ---------------------------------------------------------------------------
// Append-only storage (triggers)
// ---------------------------------------------------------------------------

describe('quality records are append-only', () => {
  it('rejects UPDATE/DELETE/TRUNCATE on judgments, snapshots and results', async () => {
    const ctx = member(tenantStorage);
    pinClock(T_MID);
    const judgment = await recordJudgment(ctx, {
      kind: 'unknown-consequentiality',
      gapKey: 'storage-gap',
      verdict: 'consequential',
      evaluator: { kind: 'person', label: 'reviewer' },
    });
    const snapshot = await computeQualitySnapshot(ctx, snapshotInput(T_START, T_END));

    const db = getDb();
    await expect(
      db.query(`UPDATE quality_judgments SET verdict = 'not_consequential' WHERE id = $1`, [judgment.id]),
    ).rejects.toThrow(/append-only/);
    await expect(db.query(`DELETE FROM quality_judgments WHERE id = $1`, [judgment.id])).rejects.toThrow(
      /append-only/,
    );
    await expect(db.query(`TRUNCATE quality_judgments`)).rejects.toThrow(/append-only/);
    await expect(
      db.query(`UPDATE quality_snapshots SET rationale = 'rewritten' WHERE id = $1`, [snapshot.id]),
    ).rejects.toThrow(/append-only/);
    await expect(db.query(`DELETE FROM quality_snapshots WHERE id = $1`, [snapshot.id])).rejects.toThrow(
      /append-only/,
    );
    await expect(
      db.query(`UPDATE quality_metric_results SET payload = '{}'::jsonb WHERE tenant_id = $1`, [
        tenantStorage,
      ]),
    ).rejects.toThrow(/append-only/);
    await expect(
      db.query(`DELETE FROM quality_metric_results WHERE tenant_id = $1`, [tenantStorage]),
    ).rejects.toThrow(/append-only/);

    // The records survive the rejected mutations untouched.
    const intact = await getJudgment(ctx, { judgmentId: judgment.id });
    expect(intact.verdict).toBe('consequential');
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation (ADR-0001)
// ---------------------------------------------------------------------------

describe('tenant isolation — uniform not-found semantics', () => {
  it('never leaks another tenant record set across the boundary', async () => {
    const ctx = member(tenantIso);
    const stranger = member(tenantStranger);
    pinClock(T_MID);

    // Tenant A's records.
    const goal = await seedGoal(ctx);
    const observationId = await seedObservation(ctx, { metric: 'monthly-churn-rate', value: 8.4 }, T_MID);
    const claimId = await seedClaim(ctx, 'Isolation churn 8.4', observationId);
    const run = await runGoalGapDiscovery(ctx, {
      trigger: { kind: 'scheduled', label: 'isolation fixture' },
      goalIds: [goal.id],
      readings: [
        { goalId: goal.id, metricName: 'monthly-churn-rate', value: 8.4, evidenceClaimIds: [claimId] },
      ],
      investigationBudget: { amount: 500_00, currency: 'EUR' },
      rewardBudget: { amount: 50_00, currency: 'EUR' },
      actor: { kind: 'system', label: 'aurum-attention' },
    });
    const candidate = run.candidates[0]!;
    const judgment = await recordJudgment(ctx, {
      kind: 'unknown-consequentiality',
      gapKey: candidate.gapKey,
      verdict: 'consequential',
      evaluator: { kind: 'person', label: 'reviewer' },
    });
    const mission = await createMission(
      ctx,
      missionInput({ candidateSources: [{ kind: 'system', label: 'ERP' }] }),
    );
    const plan = await planNextAcquisition(ctx, {
      missionId: mission.id,
      candidates: [sig('system', { label: 'ERP' })],
      actor: { kind: 'system', label: 'aurum-quality' },
    });
    const snapshot = await computeQualitySnapshot(ctx, snapshotInput(T_START, T_END));

    // Reads: the stranger sees nothing of tenant A's quality records.
    await expectCode('judgment_not_found', () => getJudgment(stranger, { judgmentId: judgment.id }));
    await expectCode('snapshot_not_found', () => getQualitySnapshot(stranger, { snapshotId: snapshot.id }));
    expect(await listJudgments(stranger, {})).toEqual([]);
    expect(await listQualitySnapshots(stranger, {})).toEqual([]);

    // Writes: the stranger cannot target tenant A's records either.
    await expectCode('invalid_candidate_ref', () =>
      recordJudgment(stranger, {
        kind: 'unknown-consequentiality',
        gapKey: candidate.gapKey,
        candidateId: candidate.id,
        verdict: 'consequential',
        evaluator: { kind: 'person', label: 'stranger' },
      }),
    );
    await expectCode('invalid_plan_ref', () =>
      recordJudgment(stranger, {
        kind: 'source-selection',
        planId: plan.id,
        verdict: 'correct',
        evaluator: { kind: 'person', label: 'stranger' },
      }),
    );

    // The stranger's own snapshot sees ONLY the stranger's tenant.
    const strangerSnapshot = await computeQualitySnapshot(stranger, snapshotInput(T_START, T_END));
    expect(strangerSnapshot.tenantId).toBe(tenantStranger);
    expect(strangerSnapshot.inputs.discoveryCandidatesConsidered).toBe(0);
    expect(strangerSnapshot.inputs.judgmentsConsidered).toBe(0);
    const strangerUnknown = strangerSnapshot.results.find(
      (result) => result.metricKind === 'unknown-discovery',
    )!.payload as UnknownDiscoveryPayload;
    expect(strangerUnknown.promotedInWindow).toBe(0);
    expect(strangerUnknown.recall).toBeNull();
  });
});
