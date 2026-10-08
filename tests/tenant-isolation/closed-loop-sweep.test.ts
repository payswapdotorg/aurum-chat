// Wave E integration (2026-10-08) — Tenant Isolation Verification · sweep
// for the closed-loop module (W140: Unified Closed-Loop Learning — the
// longitudinal loop-cycle spine, the two structurally distinct deviation
// classes and the advisory ranking signals).
//
// REAL two-tenant service proof in the W044 house style (the manifest v13
// registration): tenant A builds loop state through the public contract —
// three cycles around one REAL goal (two closed with frozen longitudinal
// metrics, one still open), each citing REAL evidence from every connected
// seam (a W136 execution run walked goal → plan → W021 execution →
// recorded run, a W137 fabric lease, a W135 calibrated recommendation, the
// goal's own metric — the REALITY class; a W125 material coverage gap
// snapshot-scoped, a W053 CompanyModel learning update — the KNOWLEDGE
// class) plus ranking signals on all three input channels (info-strategy,
// org-lab, CompanyModel subject key) — and tenant B must see none of it:
//
//   * empty-list invisibility — B's listLoopCycles / listRankingSignals
//     are empty (unfiltered AND filtered by A's goal/cycle ids), and B's
//     trajectory / improvement summary over A's goal carry zero closed
//     points and the honest 'insufficient_evidence' verdict — the
//     goal-scoped reads leak nothing;
//   * uniform not-found — a FOREIGN cycle id and a MISSING one reject
//     identically on every surface (`cycle_not_found` on the deep read,
//     the one-way close and the signal append, foreign ≡ missing on open
//     AND closed cycles alike), and the mapped `goal_not_found` /
//     `run_not_found` / `lease_not_found` / `recommendation_not_found` /
//     `gap_not_found` / `learning_update_not_found` / `strategy_not_found`
//     / `candidate_not_found` from the consumed seams cover every
//     composition path (B cannot even open a cycle over A's goal or cite
//     A's evidence, and cannot address A's strategy/candidate as a signal
//     target through B's own open cycle — the stolen-focus precedent) —
//     no existence leak (ADR-0001);
//   * same natural shapes coexist per tenant — the same goal title, the
//     same rationale/note strings and the same signal shapes live
//     independently in both tenants, each walking its own full lifecycle
//     with INDEPENDENT 1-based cycle numbering (B's first cycle is 1 even
//     though A is already at 3) and the same frozen metrics from the same
//     expected/observed inputs;
//   * writes never mutate another tenant's rows — none of B's probes
//     (close, signal, record-with-stolen-evidence) appends or advances
//     anything in A's loop: A's open cycle stays open with its deviations
//     and signals intact, and A's closed cycles stay frozen.
//
// Scope rules honored here: closed-loop code is imported ONLY through
// '@/modules/closed-loop/contract'; every fixture (goals, context,
// epistemics, info-strategy, org-lab, agents, agent-exchange,
// execution-fabric, coverage, learning) comes through its public contract
// — the consumed seams, exercised as real records, never direct SQL
// writes. This harness NEVER opens a db.transaction of its own (the W134
// single-connection law: the service opens exactly one transaction per
// mutation).

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { systemClock } from '@/infra/clock';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { runMigrations } from '../../scripts/migrate';

// The module under proof — through its contract only.
import {
  applyRankingSignal,
  closeLoopCycle,
  ClosedLoopError,
  getLoopCycle,
  getLoopTrajectory,
  listLoopCycles,
  listRankingSignals,
  recordLoopCycle,
  summarizeLoopImprovement,
} from '@/modules/closed-loop/contract';
import type { ClosedLoopErrorCode } from '@/modules/closed-loop/contract';

// The consumed seams, exercised as REAL records through their owning
// contracts (never re-derived, never direct-written):
//   goals W008 · context W134 · epistemics W004 · info-strategy W134 ·
//   org-lab W135 · agents W021 · agent-exchange W136 ·
//   execution-fabric W137 · coverage W125 · learning W053
import { createGoal } from '@/modules/goals/contract';
import type { Goal } from '@/modules/goals/contract';
import { deriveFingerprint } from '@/modules/context/contract';
import { recordUnknown } from '@/modules/epistemics/contract';
import { defineStrategy } from '@/modules/info-strategy/contract';
import type { InfoStrategy } from '@/modules/info-strategy/contract';
import { registerCandidate, recordRecommendation } from '@/modules/org-lab/contract';
import type { OrgCandidate, OrgRecommendation } from '@/modules/org-lab/contract';
import { registerAgent, setAgentTransport, submitAgentExecution } from '@/modules/agents/contract';
import type { AgentDefinition, AgentExecution, AgentRuntimeTransport } from '@/modules/agents/contract';
import * as exchange from '@/modules/agent-exchange/contract';
import type { ExecutionPlan, ExecutionRun } from '@/modules/agent-exchange/contract';
import * as fabric from '@/modules/execution-fabric/contract';
import { createLocalContainerAdapter } from '@/modules/execution-fabric/contract';
import type { FabricLease } from '@/modules/execution-fabric/contract';
import * as coverage from '@/modules/coverage/contract';
import type { CoverageGap, CoverageSnapshot } from '@/modules/coverage/contract';
import { defineOutcome, recordLearningUpdate } from '@/modules/learning/contract';
import type { LearningUpdate } from '@/modules/learning/contract';

const tenantSweepA = newId();
const tenantSweepB = newId();

// Deterministic stamps (the injectable-clock discipline): the worlds are
// built on the previous day and every loop mutation is pinned to a
// distinct instant, so list ordering (recorded_at DESC) is deterministic
// and every pinned record is already valid at the real `now` the seam
// reads compare against.
const T_WORLD = '2026-10-07T08:00:00.000Z';

// Clock-relative instants so the coverage freshness fixtures are
// deterministic regardless of when the suite runs: two hours ago is
// outside a 3600s freshness policy (STALE — the material gap).
const TWO_HOURS_AGO = new Date(Date.now() - 2 * 3600_000).toISOString();

function plusMinutes(from: string, minutes: number): string {
  return new Date(new Date(from).getTime() + minutes * 60_000).toISOString();
}

function pinClock(at: string): () => void {
  const realNow = systemClock.now;
  systemClock.now = () => new Date(at);
  return () => {
    systemClock.now = realNow;
  };
}

/** Pin the clock around one async service call (deterministic stamps). */
async function at<T>(time: string, fn: () => Promise<T>): Promise<T> {
  const unpin = pinClock(time);
  try {
    return await fn();
  } finally {
    unpin();
  }
}

function member(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: [] };
}

function admin(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: ['agents:administer'] };
}

async function expectCode(
  code: ClosedLoopErrorCode,
  fn: () => unknown,
): Promise<void> {
  try {
    await fn();
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(ClosedLoopError);
    expect((error as ClosedLoopError).code).toBe(code);
  }
}

// ---------------------------------------------------------------------------
// Fixture factories (ported from the module's own service suite — all
// content caller-supplied; no matching semantics live in these helpers)
// ---------------------------------------------------------------------------

function goalInput(title: string) {
  return {
    title,
    objective: `Objective of ${title}`,
    desiredState: `Desired state of ${title}`,
    horizonEnd: '2027-12-31T00:00:00.000Z',
    owner: { kind: 'team' as const, label: 'operations' },
    priority: 'high' as const,
    successCriteria: 'Measurable success',
    actor: { kind: 'system' as const, label: 'we-int-sweep' },
  };
}

function springObservations() {
  return {
    season: { window: 'spring', note: 'clear weather forecast' },
    duration: { durationClass: 'short' as const, estimatedSpan: '~6 weeks' },
    staffing: {
      headcount: 6,
      experienceMix: { novice: 5, intermediate: 1, expert: 0 },
      note: null,
    },
    workload: 'light' as const,
    capabilities: { available: ['ride-dispatch'], missing: [] },
    environment: { factors: ['urban'] },
    constraints: {
      budgetNote: 'lean budget',
      slaNote: '15m pickup SLA',
      qualityTarget: '4.8 stars',
      riskTolerance: 'risk-averse' as const,
      verificationRequirements: ['dual-signoff'],
    },
    evidenceFreshness: { maxEvidenceAge: '48h', criticalFreshSurfaces: ['traffic-api'] },
  };
}

/** A single-tenant-agent crew (the org-lab solo composition). */
function soloComposition() {
  return {
    nodes: [{ nodeId: 'solo', kind: 'tenant-agent' as const, role: 'Solo operator' }],
  };
}

/** Registers one active agent definition (the W021 execution side). */
async function registerTenantAgent(ctx: TenantContext, slug: string): Promise<AgentDefinition> {
  const registered = await registerAgent(ctx, {
    slug,
    displayName: slug,
    role: 'specialist execution',
    description: 'Executes the tasks the loop observes.',
    provider: 'openai-assistants',
    instructions: 'Execute the assigned task and report.',
    permissions: ['observe', 'analyze'],
    runtimeConfig: { assistantId: `asst_${slug}` },
  });
  return registered.agent;
}

/** One material coverage gap: a STALE claim on `surfaceKey` (W125). */
async function recordStaleClaim(ctx: TenantContext, surfaceKey: string, sourceRef: string) {
  await coverage.recordClaim(ctx, {
    surfaceKey,
    source: { registry: 'source', ref: sourceRef },
    observationBasis: { kind: 'observation-set', ids: [sourceRef], lastObservedAt: TWO_HOURS_AGO },
    state: 'STALE',
    freshness: { lastUsableAt: TWO_HOURS_AGO, policyMaxAgeSeconds: 3600 },
    confidenceValue: 0.7,
    reason: `${surfaceKey} evidence exceeded its freshness policy`,
  });
}

/** The full REAL W140 world of one tenant: every seam a loop cycle cites. */
interface WorldFixture {
  goal: Goal;
  strategy: InfoStrategy;
  plan: ExecutionPlan;
  run: ExecutionRun;
  lease: FabricLease;
  candidate: OrgCandidate;
  recommendation: OrgRecommendation;
  snapshot: CoverageSnapshot;
  gap: CoverageGap;
  update: LearningUpdate;
  sourceUuid: string;
}

/**
 * The full REAL W140 world fixture for one tenant: the connected seams a
 * loop cycle cites, each walked through its owning contract — goal →
 * context fingerprint → info-strategy → org-lab candidates +
 * calibrated recommendation → W136 plan → W021 execution → recorded run
 * → W137 fabric lease → W125 snapshot with a material gap → W053
 * CompanyModel learning update. Returns the records the loop's evidence
 * gates consume.
 */
async function worldFixture(
  ctx: TenantContext,
  agentAdmin: TenantContext,
  title: string,
  key: string,
): Promise<WorldFixture> {
  const goal = await createGoal(ctx, goalInput(title));
  const fingerprint = await deriveFingerprint(ctx, {
    goalId: goal.id,
    observations: springObservations(),
  });
  const unknown = await recordUnknown(ctx, {
    question: `Which organization executes ${title}?`,
    consequence: 'Not knowing this blocks the loop.',
  });
  const strategy = await defineStrategy(ctx, {
    goalId: goal.id,
    fingerprintId: fingerprint.fingerprintId,
    content: {
      knowledgeRequirements: [
        { unknownId: unknown.id, targetConfidence: 0.8, rationale: 'The loop depends on it.' },
      ],
    },
  });

  const agent = await registerTenantAgent(agentAdmin, `agent-${key}`);
  const plan = await exchange.createExecutionPlan(ctx, {
    goalId: goal.id,
    objective: `Execute ${title}`,
    tasks: [{ taskKey: 'survey', title: 'Survey the site' }],
    members: [
      { memberKey: 'lead', kind: 'tenant-agent', role: 'Lead specialist', ref: agent.id },
    ],
  });
  const execution: AgentExecution = await submitAgentExecution(ctx, {
    agentId: agent.id,
    task: { instruction: 'Survey the site', context: 'spring window' },
    requestedPermissions: ['observe'],
  });
  const run = await exchange.recordExecutionRun(ctx, {
    planId: plan.id,
    taskKey: 'survey',
    agentExecutionId: execution.id,
    context: { evidenceRefs: [`obs-${key}-1`] },
  });

  const definition = await fabric.registerEnvironmentDefinition(ctx, {
    defKey: `env-${key}`,
    displayName: 'Sweep loop workspace',
    kind: 'workspace',
    profileScope: 'task',
    networkEgress: 'restricted',
    survivesRestart: true,
    checkpoint: 'durable-checkpoint',
    persistentScope: '/workspace',
    requiredCapabilities: ['filesystem', 'commands'],
  });
  const lease = await fabric.acquireFabricLease(ctx, {
    definitionId: definition.id,
    planId: plan.id,
    executionRunId: run.id,
  });

  const candidate = await registerCandidate(ctx, {
    slug: `crew-${key}`,
    label: 'Solo crew',
    composition: soloComposition(),
  });
  // A second evaluated candidate: org-lab records CALIBRATION only over
  // two or more evaluations (the honest no-winner floor).
  const alternative = await registerCandidate(ctx, {
    slug: `alt-crew-${key}`,
    label: 'Alternative crew',
    composition: soloComposition(),
  });
  const outcome = await defineOutcome(ctx, {
    subject: { kind: 'recommendation', id: newId(), label: `we-int ${key} recommendation` },
    metricName: `surveys-${key}`,
    metricUnit: 'count',
    direction: 'at_least',
    baseline: 0,
    expected: 10,
    horizon: null,
    affectedGoals: [],
    originExecutionId: null,
    actor: { kind: 'person', label: 'ops lead' },
    rationale: 'the we-int sweep commitment',
  });
  const recommendation = await recordRecommendation(ctx, {
    goalId: goal.id,
    fingerprintId: fingerprint.fingerprintId,
    knowledgeObjective: 'An organization that executes the loop',
    evaluationConfig: { criteria: [{ name: 'fit', weight: 1 }] },
    candidates: [
      { candidateId: candidate.id, disposition: 'recommended', summary: 'Fits the observed context.' },
      {
        candidateId: alternative.id,
        disposition: 'rejected',
        rejectionReasons: ['The solo composition duplicates the recommended crew.'],
        summary: 'A real second evaluation, rejected on composition.',
      },
    ],
    expectedOutcomeIds: [outcome.id],
  });

  // The knowledge side: one surface currently STALE (material gap).
  await coverage.registerSurface(ctx, { key: 'ops-tickets', label: 'Ops tickets' });
  const sourceUuid = newId();
  await coverage.registerSource(ctx, { registry: 'source', ref: sourceUuid, label: 'Ops feed' });
  await recordStaleClaim(ctx, 'ops-tickets', sourceUuid);
  const snapshot = await coverage.evaluateSnapshot(ctx);
  const material = await coverage.listGaps(ctx, { snapshotId: snapshot.id, material: true });
  expect(material.length, 'the fixture must produce exactly one material gap').toBe(1);
  const gap = material[0] as CoverageGap;

  // The CompanyModel learning event: one recorded prior on the source,
  // citing the stale claim's observation as its provenance (ADR-0016).
  const update = await recordLearningUpdate(ctx, {
    changes: [
      {
        area: 'source_reliability',
        subject: { kind: 'source', id: sourceUuid, label: 'Ops feed' },
        topic: 'reliability',
        statement: { score: 0.85, note: 'sweep fixture prior' },
        confidence: 0.8,
        disposition: 'asserted',
        validFrom: null,
        validUntil: null,
        evidence: [
          { kind: 'observation', id: snapshot.id, label: 'the ops-tickets freshness observation' },
        ],
        outcomeId: null,
      },
    ],
    rationale: `we-int sweep: initial prior for the ${key} source`,
    actor: { kind: 'person', label: 'ops lead' },
  });

  return { goal, strategy, plan, run, lease, candidate, recommendation, snapshot, gap, update, sourceUuid };
}

let worldA: WorldFixture;
let worldB: WorldFixture;

beforeAll(async () => {
  await runMigrations(getDb());

  // The in-process fake transport (the sanctioned W021 wiring seam): no
  // real provider is contacted, and the canonical result/cost travel the
  // REAL normalized contract.
  const fakeTransport: AgentRuntimeTransport = {
    send: async () => ({
      status: 'delivered' as const,
      payload: {
        id: 'run_we_int_sweep',
        status: 'completed',
        output: [
          {
            type: 'message',
            content: [{ type: 'output_text', text: JSON.stringify({ surveyed: 3 }) }],
          },
        ],
        summary: 'Surveyed 3 sites',
        usage: { input_tokens: 120, output_tokens: 45 },
      },
      providerTaskId: 'run_we_int_sweep',
      detail: null,
    }),
  };
  setAgentTransport(fakeTransport);

  // The fabric's in-memory adapter wiring (module state, never domain
  // state): the deterministic local-container simulation.
  await fabric.registerExecutionAdapter(createLocalContainerAdapter());

  worldA = await at(T_WORLD, () =>
    worldFixture(member(tenantSweepA), admin(tenantSweepA), 'The sweep loop program', 'sweepa'),
  );
  worldB = await at(T_WORLD, () =>
    worldFixture(member(tenantSweepB), admin(tenantSweepB), 'The sweep loop program', 'sweepb'),
  );
});

afterAll(async () => {
  await closeDb();
});

describe('W044 closed-loop — loop cycles, deviations and ranking signals (W140) are tenant-scoped', () => {
  it("tenant A's loop cycles, deviation evidence and ranking signals are invisible to tenant B; the same shapes coexist per tenant", async () => {
    const userA = member(tenantSweepA);
    const userB = member(tenantSweepB);

    // ---- Tenant A: the longitudinal loop, through the real seams -------
    // Cycle 1 — the full-evidence cycle around A's own goal (citing a
    // REAL run, lease, calibration and the goal's own metric, plus a
    // REAL coverage gap and CompanyModel learning update).
    const cycleA1 = await at(plusMinutes(T_WORLD, 60), () =>
      recordLoopCycle(userA, {
        goalId: worldA.goal.id,
        predictedScore: 0.5,
        rationale: 'the full-evidence sweep cycle',
        realityDeviations: [
          { sourceKind: 'execution_run', sourceRef: worldA.run.id, planId: worldA.plan.id, expected: 0.5, observed: 0.2, note: 'the run underdelivered' },
          { sourceKind: 'fabric_lease', sourceRef: worldA.lease.id, expected: 0.5, observed: 0.25, note: 'the environment cost more than planned' },
          { sourceKind: 'org_calibration', sourceRef: worldA.recommendation.id, expected: 0.5, observed: 0.3, note: 'the recommended crew overestimated' },
          { sourceKind: 'goal_metric', sourceRef: worldA.goal.id, expected: 0.5, observed: 0.2, note: 'the goal metric missed' },
        ],
        knowledgeDeviations: [
          { sourceKind: 'coverage_gap', sourceRef: worldA.gap.id, snapshotId: worldA.snapshot.id, severity: 0.7, note: 'ops evidence was stale' },
          { sourceKind: 'learning_update', sourceRef: worldA.update.id, severity: 0.4, note: 'the source prior was wrong' },
        ],
      }),
    );
    expect(cycleA1.tenantId).toBe(tenantSweepA);
    expect(cycleA1.cycleNumber).toBe(1);
    expect(cycleA1.status).toBe('open');
    expect(cycleA1.metrics).toBeNull();
    expect(cycleA1.realityDeviations).toHaveLength(4);
    expect(cycleA1.knowledgeDeviations).toHaveLength(2);
    expect(cycleA1.realityDeviations.every((one) => one.tenantId === tenantSweepA)).toBe(true);
    expect(cycleA1.knowledgeDeviations.every((one) => one.tenantId === tenantSweepA)).toBe(true);

    // One signal per ranking input channel across the loop: org-lab on
    // cycle 1, info-strategy on cycle 2, CompanyModel on cycle 3.
    const signalA1 = await at(plusMinutes(T_WORLD, 61), () =>
      applyRankingSignal(userA, {
        cycleId: cycleA1.id,
        targetSeam: 'org_lab',
        targetRef: worldA.candidate.id,
        direction: 'lower',
        magnitude: 0.3,
        basis: 'reality_deviation',
        rationale: 'the crew ranking overweighted this source',
      }),
    );
    expect(signalA1.tenantId).toBe(tenantSweepA);
    expect(signalA1.authoritative).toBe(false);

    // The one-way close freezes the longitudinal metrics exactly once.
    const closedA1 = await at(plusMinutes(T_WORLD, 62), () =>
      closeLoopCycle(userA, { cycleId: cycleA1.id, note: 'cycle one reviewed' }),
    );
    expect(closedA1.status).toBe('closed');
    expect(closedA1.metrics).toEqual({
      observedScore: 0.2375,
      calibrationError: 0.2625,
      gapClosureRate: null,
      deviationRecurrence: null,
      realityCount: 4,
      knowledgeCount: 2,
    });

    // Cycle 2 — a leaner closed cycle (the goal metric alone).
    const cycleA2 = await at(plusMinutes(T_WORLD, 70), () =>
      recordLoopCycle(userA, {
        goalId: worldA.goal.id,
        predictedScore: 0.5,
        rationale: 'the full-evidence sweep cycle',
        realityDeviations: [
          { sourceKind: 'goal_metric', sourceRef: worldA.goal.id, expected: 0.5, observed: 0.35, note: 'the goal metric missed again' },
        ],
      }),
    );
    expect(cycleA2.cycleNumber).toBe(2);
    const signalA2 = await at(plusMinutes(T_WORLD, 71), () =>
      applyRankingSignal(userA, {
        cycleId: cycleA2.id,
        targetSeam: 'info_strategy',
        targetRef: worldA.strategy.id,
        direction: 'lower',
        magnitude: 0.2,
        basis: 'reality_deviation',
        rationale: 'the strategy ranking overweighted this source',
      }),
    );
    const closedA2 = await at(plusMinutes(T_WORLD, 72), () =>
      closeLoopCycle(userA, { cycleId: cycleA2.id, note: 'cycle two reviewed' }),
    );
    expect(closedA2.metrics).toEqual({
      observedScore: 0.35,
      calibrationError: 0.15,
      gapClosureRate: 1,
      deviationRecurrence: 1,
      realityCount: 1,
      knowledgeCount: 0,
    });

    // Cycle 3 — the still-open cycle (the state B will try to act on),
    // citing the same material gap a second time.
    const cycleA3 = await at(plusMinutes(T_WORLD, 80), () =>
      recordLoopCycle(userA, {
        goalId: worldA.goal.id,
        predictedScore: 0.45,
        rationale: 'the still-open sweep cycle',
        knowledgeDeviations: [
          { sourceKind: 'coverage_gap', sourceRef: worldA.gap.id, snapshotId: worldA.snapshot.id, severity: 0.5, note: 'ops evidence was stale' },
        ],
      }),
    );
    expect(cycleA3.cycleNumber).toBe(3);
    expect(cycleA3.status).toBe('open');
    const signalA3 = await at(plusMinutes(T_WORLD, 81), () =>
      applyRankingSignal(userA, {
        cycleId: cycleA3.id,
        targetSeam: 'company_model',
        targetRef: `source:${worldA.sourceUuid}`,
        direction: 'raise',
        magnitude: 0.15,
        basis: 'knowledge_deviation',
        rationale: 'the source proved more reliable than the model held',
      }),
    );
    expect(signalA3.tenantId).toBe(tenantSweepA);

    // ---- Tenant B sees none of it ---------------------------------------
    // Empty-list invisibility on every query path, unfiltered AND
    // filtered by A's ids: cycles, signals, trajectory, summary.
    expect(await listLoopCycles(userB, {})).toEqual([]);
    expect(await listLoopCycles(userB, { goalId: worldA.goal.id })).toEqual([]);
    expect(await listLoopCycles(userB, { goalId: worldA.goal.id, status: 'open' })).toEqual([]);
    expect(await listRankingSignals(userB, {})).toEqual([]);
    expect(await listRankingSignals(userB, { goalId: worldA.goal.id })).toEqual([]);
    expect(await listRankingSignals(userB, { cycleId: cycleA1.id })).toEqual([]);
    expect((await getLoopTrajectory(userB, { goalId: worldA.goal.id })).points).toEqual([]);
    const foreignSummary = await summarizeLoopImprovement(userB, { goalId: worldA.goal.id });
    expect(foreignSummary.tenantId).toBe(tenantSweepB);
    expect(foreignSummary.closedCycleCount).toBe(0);
    expect(foreignSummary.firstCalibrationError).toBeNull();
    expect(foreignSummary.signalCount).toBe(0);
    expect(foreignSummary.verdict).toBe('insufficient_evidence');

    // Uniform not-found: a FOREIGN cycle id and a MISSING one are
    // indistinguishable on the deep read, the close and the signal
    // append — over A's OPEN cycle and A's CLOSED cycles alike.
    await expectCode('cycle_not_found', () => getLoopCycle(userB, { cycleId: cycleA1.id }));
    await expectCode('cycle_not_found', () => getLoopCycle(userB, { cycleId: cycleA3.id }));
    await expectCode('cycle_not_found', () => getLoopCycle(userB, { cycleId: newId() }));
    await expectCode('cycle_not_found', () =>
      closeLoopCycle(userB, { cycleId: cycleA3.id, note: 'stolen close' }),
    );
    await expectCode('cycle_not_found', () =>
      closeLoopCycle(userB, { cycleId: cycleA1.id, note: 'stolen close' }),
    );
    await expectCode('cycle_not_found', () =>
      closeLoopCycle(userB, { cycleId: newId(), note: 'missing close' }),
    );
    await expectCode('cycle_not_found', () =>
      applyRankingSignal(userB, {
        cycleId: cycleA3.id,
        targetSeam: 'company_model',
        targetRef: 'company',
        direction: 'raise',
        magnitude: 0.1,
        basis: 'knowledge_deviation',
        rationale: 'stolen signal',
      }),
    );
    await expectCode('cycle_not_found', () =>
      applyRankingSignal(userB, {
        cycleId: cycleA1.id,
        targetSeam: 'org_lab',
        targetRef: worldA.candidate.id,
        direction: 'lower',
        magnitude: 0.1,
        basis: 'reality_deviation',
        rationale: 'stolen signal',
      }),
    );

    // B cannot COMPOSE over A's records either: not over A's goal (the
    // subject-goal gate — the stolen-focus precedent), not citing A's
    // evidence through the consumed seams' uniform mapped not-founds
    // (every deviation class and source kind), and not addressing A's
    // strategy/candidate as a signal target through B's OWN open cycle.
    await expectCode('goal_not_found', () =>
      recordLoopCycle(userB, {
        goalId: worldA.goal.id,
        predictedScore: 0.5,
        rationale: 'stolen-focus cycle',
      }),
    );
    const stolenEvidence = {
      goalId: worldB.goal.id,
      predictedScore: 0.5,
      rationale: 'stolen-evidence cycle',
    };
    await expectCode('run_not_found', () =>
      recordLoopCycle(userB, {
        ...stolenEvidence,
        realityDeviations: [
          { sourceKind: 'execution_run', sourceRef: worldA.run.id, planId: worldA.plan.id, expected: 0.5, observed: 0.2, note: 'stolen run' },
        ],
      }),
    );
    await expectCode('lease_not_found', () =>
      recordLoopCycle(userB, {
        ...stolenEvidence,
        realityDeviations: [
          { sourceKind: 'fabric_lease', sourceRef: worldA.lease.id, expected: 0.5, observed: 0.2, note: 'stolen lease' },
        ],
      }),
    );
    await expectCode('recommendation_not_found', () =>
      recordLoopCycle(userB, {
        ...stolenEvidence,
        realityDeviations: [
          { sourceKind: 'org_calibration', sourceRef: worldA.recommendation.id, expected: 0.5, observed: 0.2, note: 'stolen calibration' },
        ],
      }),
    );
    await expectCode('gap_not_found', () =>
      recordLoopCycle(userB, {
        ...stolenEvidence,
        knowledgeDeviations: [
          { sourceKind: 'coverage_gap', sourceRef: worldA.gap.id, snapshotId: worldA.snapshot.id, severity: 0.7, note: 'stolen gap' },
        ],
      }),
    );
    await expectCode('learning_update_not_found', () =>
      recordLoopCycle(userB, {
        ...stolenEvidence,
        knowledgeDeviations: [
          { sourceKind: 'learning_update', sourceRef: worldA.update.id, severity: 0.4, note: 'stolen update' },
        ],
      }),
    );

    // ---- B's own state (the coexistence shapes) -------------------------
    // The SAME goal title, rationale, note and signal rationale strings
    // live independently in B even though A already used them — per-
    // tenant namespaces only, with INDEPENDENT cycle numbering (B's
    // first cycle is 1 although A is already at 3).
    expect(worldB.goal.content.title).toBe(worldA.goal.content.title);
    const cycleB1 = await at(plusMinutes(T_WORLD, 90), () =>
      recordLoopCycle(userB, {
        goalId: worldB.goal.id,
        predictedScore: 0.5,
        rationale: 'the full-evidence sweep cycle',
        realityDeviations: [
          { sourceKind: 'execution_run', sourceRef: worldB.run.id, planId: worldB.plan.id, expected: 0.5, observed: 0.2, note: 'the run underdelivered' },
          { sourceKind: 'fabric_lease', sourceRef: worldB.lease.id, expected: 0.5, observed: 0.25, note: 'the environment cost more than planned' },
          { sourceKind: 'org_calibration', sourceRef: worldB.recommendation.id, expected: 0.5, observed: 0.3, note: 'the recommended crew overestimated' },
          { sourceKind: 'goal_metric', sourceRef: worldB.goal.id, expected: 0.5, observed: 0.2, note: 'the goal metric missed' },
        ],
        knowledgeDeviations: [
          { sourceKind: 'coverage_gap', sourceRef: worldB.gap.id, snapshotId: worldB.snapshot.id, severity: 0.7, note: 'ops evidence was stale' },
          { sourceKind: 'learning_update', sourceRef: worldB.update.id, severity: 0.4, note: 'the source prior was wrong' },
        ],
      }),
    );
    expect(cycleB1.tenantId).toBe(tenantSweepB);
    expect(cycleB1.goalId).toBe(worldB.goal.id);
    expect(cycleB1.cycleNumber).toBe(1);
    expect(cycleB1.id).not.toBe(cycleA1.id);
    expect(cycleB1.realityDeviations).toHaveLength(4);
    expect(cycleB1.knowledgeDeviations).toHaveLength(2);

    // The signal-target refusals through B's OWN open cycle: A's
    // strategy and A's candidate are uniformly not-found targets.
    await expectCode('strategy_not_found', () =>
      applyRankingSignal(userB, {
        cycleId: cycleB1.id,
        targetSeam: 'info_strategy',
        targetRef: worldA.strategy.id,
        direction: 'lower',
        magnitude: 0.2,
        basis: 'reality_deviation',
        rationale: 'stolen strategy target',
      }),
    );
    await expectCode('candidate_not_found', () =>
      applyRankingSignal(userB, {
        cycleId: cycleB1.id,
        targetSeam: 'org_lab',
        targetRef: worldA.candidate.id,
        direction: 'lower',
        magnitude: 0.3,
        basis: 'reality_deviation',
        rationale: 'stolen candidate target',
      }),
    );

    // B walks its own full lifecycle (the surface serves B normally —
    // isolation is not breakage): signal → close → second cycle.
    const signalB1 = await at(plusMinutes(T_WORLD, 91), () =>
      applyRankingSignal(userB, {
        cycleId: cycleB1.id,
        targetSeam: 'org_lab',
        targetRef: worldB.candidate.id,
        direction: 'lower',
        magnitude: 0.3,
        basis: 'reality_deviation',
        rationale: 'the crew ranking overweighted this source',
      }),
    );
    expect(signalB1.authoritative).toBe(false);
    const closedB1 = await at(plusMinutes(T_WORLD, 92), () =>
      closeLoopCycle(userB, { cycleId: cycleB1.id, note: 'cycle one reviewed' }),
    );
    // Same expected/observed inputs → the SAME frozen metrics as A's
    // cycle 1, in a fully independent row.
    expect(closedB1.metrics).toEqual(closedA1.metrics);
    const cycleB2 = await at(plusMinutes(T_WORLD, 100), () =>
      recordLoopCycle(userB, {
        goalId: worldB.goal.id,
        predictedScore: 0.5,
        rationale: 'the full-evidence sweep cycle',
        realityDeviations: [
          { sourceKind: 'goal_metric', sourceRef: worldB.goal.id, expected: 0.5, observed: 0.35, note: 'the goal metric missed again' },
        ],
      }),
    );
    expect(cycleB2.cycleNumber).toBe(2);
    const signalB2 = await at(plusMinutes(T_WORLD, 101), () =>
      applyRankingSignal(userB, {
        cycleId: cycleB2.id,
        targetSeam: 'info_strategy',
        targetRef: worldB.strategy.id,
        direction: 'lower',
        magnitude: 0.2,
        basis: 'reality_deviation',
        rationale: 'the strategy ranking overweighted this source',
      }),
    );
    const closedB2 = await at(plusMinutes(T_WORLD, 102), () =>
      closeLoopCycle(userB, { cycleId: cycleB2.id, note: 'cycle two reviewed' }),
    );
    expect(closedB2.metrics).toEqual(closedA2.metrics);

    // ---- The lists and longitudinal reads stay tenant-scoped ------------
    expect((await listLoopCycles(userA, {})).map((one) => one.id)).toEqual([
      cycleA3.id,
      cycleA2.id,
      cycleA1.id,
    ]);
    expect((await listLoopCycles(userA, { goalId: worldA.goal.id, status: 'open' })).map((one) => one.id)).toEqual([
      cycleA3.id,
    ]);
    expect((await listLoopCycles(userA, { status: 'closed' })).map((one) => one.id)).toEqual([
      cycleA2.id,
      cycleA1.id,
    ]);
    expect((await listLoopCycles(userB, {})).map((one) => one.id)).toEqual([
      cycleB2.id,
      cycleB1.id,
    ]);
    expect((await listLoopCycles(userB, { goalId: worldA.goal.id })).map((one) => one.id)).toEqual([]);

    expect((await listRankingSignals(userA, {})).map((one) => one.id)).toEqual([
      signalA3.id,
      signalA2.id,
      signalA1.id,
    ]);
    expect((await listRankingSignals(userA, { cycleId: cycleA1.id })).map((one) => one.id)).toEqual([
      signalA1.id,
    ]);
    expect((await listRankingSignals(userA, { targetSeam: 'org_lab' })).map((one) => one.id)).toEqual([
      signalA1.id,
    ]);
    expect((await listRankingSignals(userA, { basis: 'knowledge_deviation' })).map((one) => one.id)).toEqual([
      signalA3.id,
    ]);
    expect((await listRankingSignals(userA, { goalId: worldA.goal.id, targetSeam: 'info_strategy' })).map((one) => one.id)).toEqual([
      signalA2.id,
    ]);
    expect((await listRankingSignals(userB, {})).map((one) => one.id)).toEqual([
      signalB2.id,
      signalB1.id,
    ]);
    expect(await listRankingSignals(userB, { targetSeam: 'company_model' })).toEqual([]);

    // A's trajectory carries exactly its own closed cycles with the
    // frozen metrics; B's carries its own; neither leaks the other's.
    const trajectoryA = await getLoopTrajectory(userA, { goalId: worldA.goal.id });
    expect(trajectoryA.tenantId).toBe(tenantSweepA);
    expect(trajectoryA.points.map((point) => point.cycleNumber)).toEqual([1, 2]);
    expect(trajectoryA.points[0]).toMatchObject({
      observedScore: 0.2375,
      calibrationError: 0.2625,
      gapClosureRate: null,
      deviationRecurrence: null,
      signalCount: 1,
    });
    expect(trajectoryA.points[1]).toMatchObject({
      observedScore: 0.35,
      calibrationError: 0.15,
      gapClosureRate: 1,
      deviationRecurrence: 1,
      signalCount: 1,
    });
    const trajectoryB = await getLoopTrajectory(userB, { goalId: worldB.goal.id });
    expect(trajectoryB.points.map((point) => point.cycleNumber)).toEqual([1, 2]);
    expect((await getLoopTrajectory(userB, { goalId: worldA.goal.id })).points).toEqual([]);

    // The honest improvement rollups: A and B each improved over their
    // OWN two closed cycles; B reading A's goal still measures nothing.
    const summaryA = await summarizeLoopImprovement(userA, { goalId: worldA.goal.id });
    expect(summaryA).toMatchObject({
      tenantId: tenantSweepA,
      closedCycleCount: 2,
      firstCalibrationError: 0.2625,
      lastCalibrationError: 0.15,
      calibrationDelta: 0.1125,
      signalCount: 3,
      verdict: 'improved',
    });
    const summaryB = await summarizeLoopImprovement(userB, { goalId: worldB.goal.id });
    expect(summaryB).toMatchObject({
      tenantId: tenantSweepB,
      closedCycleCount: 2,
      calibrationDelta: 0.1125,
      signalCount: 2,
      verdict: 'improved',
    });
    expect(await summarizeLoopImprovement(userB, { goalId: worldA.goal.id })).toMatchObject({
      closedCycleCount: 0,
      verdict: 'insufficient_evidence',
    });

    // ---- A's state is untouched by any of B's probes ---------------------
    // The open cycle B tried to close and signal is still open with its
    // knowledge deviation and its CompanyModel signal intact; the closed
    // cycles B tried to re-close stay frozen with their evidence and
    // signals; the stolen-evidence cycles appended NOTHING to B's loop.
    const afterA3 = await getLoopCycle(userA, { cycleId: cycleA3.id });
    expect(afterA3.status).toBe('open');
    expect(afterA3.knowledgeDeviations).toHaveLength(1);
    expect(afterA3.signals.map((one) => one.id)).toEqual([signalA3.id]);
    const afterA1 = await getLoopCycle(userA, { cycleId: cycleA1.id });
    expect(afterA1.status).toBe('closed');
    expect(afterA1.metrics).toEqual(closedA1.metrics);
    expect(afterA1.realityDeviations).toHaveLength(4);
    expect(afterA1.knowledgeDeviations).toHaveLength(2);
    expect(afterA1.signals.map((one) => one.id)).toEqual([signalA1.id]);
    expect((await listLoopCycles(userA, {})).map((one) => one.id)).toEqual([
      cycleA3.id,
      cycleA2.id,
      cycleA1.id,
    ]);
    expect((await listLoopCycles(userB, {})).map((one) => one.id)).toEqual([
      cycleB2.id,
      cycleB1.id,
    ]);
    expect((await listRankingSignals(userB, {})).map((one) => one.id)).toEqual([
      signalB2.id,
      signalB1.id,
    ]);
  });
});
