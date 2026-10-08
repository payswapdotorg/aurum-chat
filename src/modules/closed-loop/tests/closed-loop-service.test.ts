// Service proofs for the closed-loop module (W140) against the embedded
// PostgreSQL (PGlite, `:memory:`) through the db port. Covers the W140
// acceptance (spec/work-items/WORK-ITEM-CATALOG.md §W140):
//
//   * REALITY AND KNOWLEDGE DEVIATIONS REMAIN DISTINCT (clause 1) —
//     both classes recorded around REAL cross-module evidence (a W136
//     execution run walked goal → plan → W021 execution → recorded run;
//     a W137 fabric lease acquired on that run; a W135 calibrated
//     organization recommendation; the goal's own metric — the REALITY
//     class; a W125 material coverage gap snapshot-scoped; a W053
//     CompanyModel learning update — the KNOWLEDGE class), stored in
//     the two distinct tables and read back through the distinct paths
//     with the class-specific fields; a deviation shaped as the OTHER
//     class is refused by recordLoopCycle with NOTHING appended;
//   * LEARNING CHANGES FUTURE RANKING WITHOUT SILENTLY OVERRIDING
//     POLICY (clause 2) — every learning application is an explicit,
//     recorded, reviewable RankingSignal with `authoritative:false`
//     MINTED (never caller-suppliable); policy/settings/authority-shaped
//     targets are refused with the dedicated typed code on BOTH the
//     mutation and the query surface; recording signals against all
//     three ranking input channels leaves the target seams' own state
//     untouched (the strategy's content, the candidate, the CompanyModel
//     ranking — verbatim identical before/after, and no learning update
//     minted); the CompanyModel's ranking changes ONLY through its own
//     recorded channel (an explicit learning update with rationale),
//     and explicit policy constraints stay authoritative over every
//     learned prior (a policy-excluded kind ranks last no matter how
//     reliable it has learned to be);
//   * LONGITUDINAL EVIDENCE SHOWS MEASURABLE IMPROVEMENT (clause 3) —
//     a deterministic four-cycle loop around one goal: each cycle's
//     prediction is adjusted by applying the cycle's RECORDED signals
//     through the exported deterministic fold (the same single
//     definition the service consumes), and the frozen calibration
//     errors shrink strictly cycle-over-cycle (0.3 → 0.225 → 0.1687 →
//     0.1266) while a CONTROL loop over the same world without signals
//     stays flat (0.3 throughout) — the trajectory and summary reads
//     carry the series and the honest verdicts ('improved' vs 'flat');
//   * THE LIFECYCLE — cycle numbers are 1-based, monotonic and per
//     (tenant, goal); the one-way open → closed transition freezes the
//     metrics exactly once under a FOR UPDATE staleness re-check;
//     signals refuse on closed cycles with NOTHING appended; the
//     unmeasured cycle stays honestly unmeasured (nulls, never
//     defaults);
//   * TYPED ERROR PATHS — foreign/missing evidence citations read
//     uniformly as their mapped not-found codes (no existence leak);
//     archived goals refuse; malformed inputs refuse; NOTHING is
//     appended on any refusal;
//   * TENANT ISOLATION (ADR-0001) — two tenants hold fully independent
//     loops: same-shaped cycles coexist with independent numbering,
//     foreign reads are uniformly not-found, and neither cycles,
//     deviations nor signals leak across the boundary;
//   * THE STORAGE LAWS — the three evidence tables are append-only
//     (UPDATE/DELETE/TRUNCATE rejected outright); the cycle spine's
//     identity columns are immutable and closed metrics frozen (direct
//     SQL probes — the deliberate exception proving the schema's own
//     laws).
//
// TRANSACTION DISCIPLINE (the W134 lesson, binding): this harness NEVER
// opens a db.transaction of its own — the service opens exactly one
// transaction per mutation on the single PGlite connection, and a
// harness transaction around a service call would deadlock the embedded
// database. Every fixture below is built through the REAL public
// contracts (goals, context, epistemics, info-strategy, org-lab,
// agents, agent-exchange, execution-fabric, coverage, learning — the
// full W140 seam map), never by direct SQL writes (the storage-law
// probes are the deliberate exception: they prove the schema's own
// laws).

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { systemClock } from '@/infra/clock';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { runMigrations } from '../../../../scripts/migrate';

// The module under proof — through its contract only (rule (b)).
import * as loop from '../contract';
import { ClosedLoopError } from '../contract';
import type { ClosedLoopErrorCode, LoopCycle, RankingSignal } from '../contract';
// The deterministic fold + derivation the loop consumes (never
// re-derived here — the same exported single definitions).
import { applyRankingSignals, deriveSignalDirection, deriveSignalMagnitude } from '../contract';

// The consumed seams, exercised as REAL records through their owning
// contracts (never re-derived, never direct-written):
//   goals W008 · context W134 · epistemics W004 · info-strategy W134 ·
//   org-lab W135 · agents W021 · agent-exchange W136 ·
//   execution-fabric W137 · coverage W125 · learning W053
import { createGoal, reviseGoal } from '@/modules/goals/contract';
import type { Goal } from '@/modules/goals/contract';
import { deriveFingerprint } from '@/modules/context/contract';
import type { ContextFingerprint } from '@/modules/context/contract';
import { recordUnknown } from '@/modules/epistemics/contract';
import { defineStrategy, getStrategy } from '@/modules/info-strategy/contract';
import type { InfoStrategy } from '@/modules/info-strategy/contract';
import { registerCandidate, recordRecommendation, getCandidate } from '@/modules/org-lab/contract';
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
import { defineOutcome, listLearningUpdates, rankCandidates, recordLearningUpdate } from '@/modules/learning/contract';
import type { LearningUpdate } from '@/modules/learning/contract';

// Deterministic service-clock pins (the injectable clock discipline —
// same-millisecond writes must not decide what a proof shows). All pins
// are on the PREVIOUS day so every pinned record (the fixture's
// CompanyModel assertions included) is already valid at the real
// `now` the seam reads compare against.
const T_FIXTURE = '2026-10-07T08:00:00.000Z';
const T_UPDATE_TWO = '2026-10-07T08:10:00.000Z';
const T_LEARN_BASE = '2026-10-07T10:00:00.000Z';
const T_CONTROL_BASE = '2026-10-07T11:00:00.000Z';
const T_ERR_BASE = '2026-10-07T12:00:00.000Z';
const T_ISO_BASE = '2026-10-07T13:00:00.000Z';

// Clock-relative instants so freshness measurements are deterministic
// regardless of when the suite runs: 30 minutes ago is within an
// 86400s policy; two hours ago is outside a 3600s policy.
const HALF_HOUR_AGO = new Date(Date.now() - 30 * 60_000).toISOString();
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

function member(
  tenantId: string,
  principalId = newId(),
  authority: string[] = [],
): TenantContext {
  return { tenantId, principalId, authority };
}

async function expectCode(
  code: ClosedLoopErrorCode,
  fn: () => Promise<unknown>,
): Promise<ClosedLoopError> {
  try {
    await fn();
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(ClosedLoopError);
    const typed = error as ClosedLoopError;
    expect(typed.code).toBe(code);
    return typed;
  }
}

// ---------------------------------------------------------------------------
// Fixture factories (all content caller-supplied — no industry or
// matching semantics live in these helpers, only the exact strings the
// fixtures declare and observe)
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
    actor: { kind: 'system' as const, label: 'w140-test' },
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

/** One fresh COVERED claim (closes the surface for later snapshots). */
async function recordCoveredClaim(ctx: TenantContext, surfaceKey: string, sourceRef: string) {
  await coverage.recordClaim(ctx, {
    surfaceKey,
    source: { registry: 'source', ref: sourceRef },
    observationBasis: { kind: 'observation-set', ids: [sourceRef], lastObservedAt: HALF_HOUR_AGO },
    state: 'COVERED',
    freshness: { lastUsableAt: HALF_HOUR_AGO, policyMaxAgeSeconds: 86400 },
    confidenceValue: 0.9,
    reason: `${surfaceKey} sync within freshness policy`,
  });
}

/** The full REAL W140 world of one tenant: every seam a loop cycle cites. */
interface WorldFixture {
  goal: Goal;
  fingerprint: ContextFingerprint;
  strategy: InfoStrategy;
  plan: ExecutionPlan;
  run: ExecutionRun;
  lease: FabricLease;
  candidate: OrgCandidate;
  recommendation: OrgRecommendation;
  snapshotOne: CoverageSnapshot;
  gapOne: CoverageGap;
  updateOne: LearningUpdate;
  sourceUuid: string;
  /** A second snapshot with a DIFFERENT material gap (tenantLearn only). */
  snapshotTwo?: CoverageSnapshot;
  gapTwo?: CoverageGap;
}

/**
 * The full REAL W140 world fixture for one tenant: the connected seams a
 * loop cycle cites, each walked through its owning contract — goal →
 * context fingerprint → info-strategy → org-lab candidate +
 * recommendation → W136 plan → W021 execution → recorded run → W137
 * fabric lease → W125 snapshot with a material gap → W053 CompanyModel
 * learning update. Returns the records the loop's evidence gates consume.
 */
async function worldFixture(
  ctx: TenantContext,
  admin: TenantContext,
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

  const agent = await registerTenantAgent(admin, `agent-${key}`);
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
    displayName: 'Loop workspace',
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
  // two or more evaluations (the honest no-winner floor), so the loop's
  // org_calibration evidence is always a real comparison — never a
  // single-option rubber stamp.
  const alternative = await registerCandidate(ctx, {
    slug: `alt-crew-${key}`,
    label: 'Alternative crew',
    composition: soloComposition(),
  });
  const outcome = await defineOutcome(ctx, {
    subject: { kind: 'recommendation', id: newId(), label: `w140 ${key} recommendation` },
    metricName: `surveys-${key}`,
    metricUnit: 'count',
    direction: 'at_least',
    baseline: 0,
    expected: 10,
    horizon: null,
    affectedGoals: [],
    originExecutionId: null,
    actor: { kind: 'person', label: 'ops lead' },
    rationale: 'the w140 commitment',
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

  // The knowledge side: two surfaces, one currently STALE (material gap).
  await coverage.registerSurface(ctx, { key: 'ops-tickets', label: 'Ops tickets' });
  await coverage.registerSurface(ctx, { key: 'meetings', label: 'Meetings' });
  const sourceUuid = newId();
  await coverage.registerSource(ctx, { registry: 'source', ref: sourceUuid, label: 'Ops feed' });
  await recordStaleClaim(ctx, 'ops-tickets', sourceUuid);
  const snapshotOne = await coverage.evaluateSnapshot(ctx);
  const materialOne = await coverage.listGaps(ctx, { snapshotId: snapshotOne.id, material: true });
  expect(materialOne.length, 'the fixture must produce exactly one material gap').toBe(1);
  const gapOne = materialOne[0] as CoverageGap;

  // The CompanyModel learning event: one recorded prior on the source,
  // citing the stale claim's observation as its provenance (ADR-0016:
  // an assertion that cites nothing is not learnable).
  const updateOne = await recordLearningUpdate(ctx, {
    changes: [
      {
        area: 'source_reliability',
        subject: { kind: 'source', id: sourceUuid, label: 'Ops feed' },
        topic: 'reliability',
        statement: { score: 0.85, note: 'fixture prior' },
        confidence: 0.8,
        disposition: 'asserted',
        validFrom: null,
        validUntil: null,
        evidence: [
          { kind: 'observation', id: snapshotOne.id, label: 'the ops-tickets freshness observation' },
        ],
        outcomeId: null,
      },
    ],
    rationale: `w140 fixture: initial prior for the ${key} source`,
    actor: { kind: 'person', label: 'ops lead' },
  });

  return {
    goal,
    fingerprint,
    strategy,
    plan,
    run,
    lease,
    candidate,
    recommendation,
    snapshotOne,
    gapOne,
    updateOne,
    sourceUuid,
  };
}

// ---------------------------------------------------------------------------
// Tenants (dedicated per concern so count/order assertions stay deterministic)
// ---------------------------------------------------------------------------

const tenantLearn = newId();
const tenantControl = newId();
const tenantErr = newId();
const tenantIsoA = newId();
const tenantIsoB = newId();

let worldLearn: WorldFixture;
let worldControl: WorldFixture;
let worldErr: WorldFixture;
let worldErrOtherGoal: Goal;
let strategyErrOtherGoal: InfoStrategy;
let planErrB: ExecutionPlan;
let runErrB: ExecutionRun;
let snapshotErrTwo: CoverageSnapshot;
let gapErrTwo: CoverageGap;
let goalErrArchived: Goal;
let worldIsoA: WorldFixture;
let worldIsoB: WorldFixture;

// The deterministic longitudinal scenario constants (clause 3): a
// stable world measured at 0.2 against a first prediction of 0.5.
const WORLD_OBSERVED = 0.2;
const BASE_PREDICTION = 0.5;
const CYCLE_COUNT = 4;

/** The frozen predictions of the learning loop (fold-verified: each
 * value is the ACTUAL output of the exported applyRankingSignals fold
 * over the recorded signal sequence — IEEE-754 reality, not idealized
 * decimal arithmetic: 0.425 − 0.05625 is 0.36874999…, which round4
 * freezes as 0.3687, not the pencil-and-paper 0.3688). */
const EXPECTED_LEARN_PREDICTIONS = [0.5, 0.425, 0.3687, 0.3266];
/** The frozen calibration errors of the learning loop (|prediction −
 * observed| over the ACTUAL fold outputs above). */
const EXPECTED_LEARN_ERRORS = [0.3, 0.225, 0.1687, 0.1266];

/** The learning loop's recorded signals, in fold order. */
const learnSignals: RankingSignal[] = [];

beforeAll(async () => {
  await runMigrations(getDb());

  // The in-process fake transport (the sanctioned W021 wiring seam):
  // no real provider is contacted, and the canonical result/cost travel
  // the REAL normalized contract.
  const fakeTransport: AgentRuntimeTransport = {
    send: async () => ({
      status: 'delivered' as const,
      payload: {
        id: 'run_w140_fixture',
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
      providerTaskId: 'run_w140_fixture',
      detail: null,
    }),
  };
  setAgentTransport(fakeTransport);

  // The fabric's in-memory adapter wiring (module state, never domain
  // state): the deterministic local-container simulation serving the
  // frozen 'workspace' kind.
  await fabric.registerExecutionAdapter(createLocalContainerAdapter());

  // ------------------------------------------------------------------
  // tenantLearn + tenantControl — the two loops over the same world.
  // ------------------------------------------------------------------
  const learn = member(tenantLearn);
  const learnAdmin = member(tenantLearn, newId(), ['agents:administer']);
  worldLearn = await at(T_FIXTURE, () => worldFixture(learn, learnAdmin, 'The learning loop program', 'learn'));

  // The second snapshot for the knowledge side of the improvement
  // scenario: ops-tickets covered, meetings now STALE — a NEW material
  // gap (cycle 2's knowledge citation; cycle 1's gap does not recur).
  await recordCoveredClaim(learn, 'ops-tickets', worldLearn.sourceUuid);
  await recordStaleClaim(learn, 'meetings', worldLearn.sourceUuid);
  const snapshotLearnTwo = await coverage.evaluateSnapshot(learn);
  const materialTwo = await coverage.listGaps(learn, { snapshotId: snapshotLearnTwo.id, material: true });
  expect(materialTwo.length, 'the second fixture snapshot must produce exactly one material gap').toBe(1);
  worldLearn = {
    ...worldLearn,
    snapshotTwo: snapshotLearnTwo,
    gapTwo: materialTwo[0] as CoverageGap,
  };

  const control = member(tenantControl);
  const controlAdmin = member(tenantControl, newId(), ['agents:administer']);
  worldControl = await at(T_FIXTURE, () => worldFixture(control, controlAdmin, 'The control loop program', 'control'));

  // ------------------------------------------------------------------
  // tenantErr — the typed error path fixtures.
  // ------------------------------------------------------------------
  const errer = member(tenantErr);
  const errAdmin = member(tenantErr, newId(), ['agents:administer']);
  worldErr = await at(T_FIXTURE, () => worldFixture(errer, errAdmin, 'The error-path program', 'err'));

  // A SECOND goal + strategy in the same tenant (goal-mismatch proof),
  // a second plan with its own run (wrong-plan citation proof), a
  // second snapshot with a fresh gap (wrong-snapshot citation proof)
  // and an archived goal (goal_not_active proof).
  worldErrOtherGoal = await createGoal(errer, goalInput('The other-goal program'));
  const fpOther = await deriveFingerprint(errer, {
    goalId: worldErrOtherGoal.id,
    observations: springObservations(),
  });
  const unknownOther = await recordUnknown(errer, {
    question: 'What executes the other-goal program?',
    consequence: 'Not knowing this blocks the test.',
  });
  strategyErrOtherGoal = await defineStrategy(errer, {
    goalId: worldErrOtherGoal.id,
    fingerprintId: fpOther.fingerprintId,
    content: {
      knowledgeRequirements: [
        { unknownId: unknownOther.id, targetConfidence: 0.8, rationale: 'The test depends on it.' },
      ],
    },
  });
  const agentErrB = await registerTenantAgent(errAdmin, 'agent-err-b');
  planErrB = await exchange.createExecutionPlan(errer, {
    goalId: worldErr.goal.id,
    objective: 'A second plan (the wrong-plan citation proof)',
    tasks: [{ taskKey: 'probe', title: 'Probe' }],
    members: [
      { memberKey: 'lead', kind: 'tenant-agent', role: 'Lead', ref: agentErrB.id },
    ],
  });
  const executionErrB = await submitAgentExecution(errer, {
    agentId: agentErrB.id,
    task: { instruction: 'Probe', context: 'spring window' },
    requestedPermissions: ['observe'],
  });
  runErrB = await exchange.recordExecutionRun(errer, {
    planId: planErrB.id,
    taskKey: 'probe',
    agentExecutionId: executionErrB.id,
    context: { evidenceRefs: ['obs-err-b'] },
  });
  await recordCoveredClaim(errer, 'ops-tickets', worldErr.sourceUuid);
  await recordStaleClaim(errer, 'meetings', worldErr.sourceUuid);
  snapshotErrTwo = await coverage.evaluateSnapshot(errer);
  const materialErrTwo = await coverage.listGaps(errer, { snapshotId: snapshotErrTwo.id, material: true });
  gapErrTwo = materialErrTwo[0] as CoverageGap;
  goalErrArchived = await createGoal(errer, goalInput('The archived program'));
  await reviseGoal(errer, {
    goalId: goalErrArchived.id,
    status: 'archived',
    actor: { kind: 'system', label: 'w140-test' },
  });

  // ------------------------------------------------------------------
  // tenantIsoA / tenantIsoB — isolation fixtures.
  // ------------------------------------------------------------------
  const isoA = member(tenantIsoA);
  const isoAAdmin = member(tenantIsoA, newId(), ['agents:administer']);
  const isoB = member(tenantIsoB);
  const isoBAdmin = member(tenantIsoB, newId(), ['agents:administer']);
  worldIsoA = await at(T_FIXTURE, () => worldFixture(isoA, isoAAdmin, 'The isolation program A', 'isoa'));
  worldIsoB = await at(T_FIXTURE, () => worldFixture(isoB, isoBAdmin, 'The isolation program B', 'isob'));
});

afterAll(async () => {
  await closeDb();
});

// ---------------------------------------------------------------------------
// Acceptance clause 1 — reality and knowledge deviations remain distinct
// ---------------------------------------------------------------------------

describe('recordLoopCycle — the longitudinal record with both deviation classes', () => {
  it('records a cycle citing REAL evidence from every seam, in the two distinct classes', async () => {
    const learn = member(tenantLearn);
    const cycle = await at(plusMinutes(T_LEARN_BASE, 0), () =>
      loop.recordLoopCycle(learn, {
        goalId: worldLearn.goal.id,
        predictedScore: 0.5,
        rationale: 'the full-evidence cycle',
        realityDeviations: [
          { sourceKind: 'execution_run', sourceRef: worldLearn.run.id, planId: worldLearn.plan.id, expected: 0.5, observed: 0.2, note: 'the run underdelivered' },
          { sourceKind: 'fabric_lease', sourceRef: worldLearn.lease.id, expected: 0.5, observed: 0.25, note: 'the environment cost more than planned' },
          { sourceKind: 'org_calibration', sourceRef: worldLearn.recommendation.id, expected: 0.5, observed: 0.3, note: 'the recommended crew overestimated' },
          { sourceKind: 'goal_metric', sourceRef: worldLearn.goal.id, expected: 0.5, observed: 0.2, note: 'the goal metric missed' },
        ],
        knowledgeDeviations: [
          { sourceKind: 'coverage_gap', sourceRef: worldLearn.gapOne.id, snapshotId: worldLearn.snapshotOne.id, severity: 0.7, note: 'ops evidence was stale' },
          { sourceKind: 'learning_update', sourceRef: worldLearn.updateOne.id, severity: 0.4, note: 'the source prior was wrong' },
        ],
      }),
    );

    expect(cycle.tenantId).toBe(tenantLearn);
    expect(cycle.goalId).toBe(worldLearn.goal.id);
    expect(cycle.goalVersion).toBe(worldLearn.goal.version);
    expect(cycle.cycleNumber).toBe(1);
    expect(cycle.status).toBe('open');
    expect(cycle.predictedScore).toBe(0.5);
    expect(cycle.metrics).toBeNull();
    expect(cycle.recordedBy).toBe(learn.principalId);
    expect(cycle.closedAt).toBeNull();
    expect(cycle.closeNote).toBeNull();

    // THE TWO CLASSES, DISTINCT PATHS, DISTINCT FIELDS: the reality
    // class carries expected/observed/planRef and NEVER
    // severity/snapshotRef; the knowledge class carries
    // severity/snapshotRef and NEVER expected/observed/planRef.
    expect(cycle.realityDeviations).toHaveLength(4);
    expect(cycle.knowledgeDeviations).toHaveLength(2);
    const bySource = (kind: string) =>
      cycle.realityDeviations.find((one) => one.sourceKind === kind)!;
    const runDeviation = bySource('execution_run');
    expect(runDeviation.sourceRef).toBe(worldLearn.run.id);
    expect(runDeviation.planRef).toBe(worldLearn.plan.id);
    expect(runDeviation.expected).toBe(0.5);
    expect(runDeviation.observed).toBe(0.2);
    expect(runDeviation.magnitude).toBe(0.3);
    expect('severity' in runDeviation).toBe(false);
    expect('snapshotRef' in runDeviation).toBe(false);
    const leaseDeviation = bySource('fabric_lease');
    expect(leaseDeviation.sourceRef).toBe(worldLearn.lease.id);
    expect(leaseDeviation.planRef).toBeNull();
    const calibrationDeviation = bySource('org_calibration');
    expect(calibrationDeviation.sourceRef).toBe(worldLearn.recommendation.id);
    const goalDeviation = bySource('goal_metric');
    expect(goalDeviation.sourceRef).toBe(worldLearn.goal.id);
    expect(goalDeviation.magnitude).toBe(0.3);

    const gapDeviation = cycle.knowledgeDeviations.find((one) => one.sourceKind === 'coverage_gap')!;
    expect(gapDeviation.sourceRef).toBe(worldLearn.gapOne.id);
    expect(gapDeviation.snapshotRef).toBe(worldLearn.snapshotOne.id);
    expect(gapDeviation.severity).toBe(0.7);
    expect('expected' in gapDeviation).toBe(false);
    expect('observed' in gapDeviation).toBe(false);
    expect('planRef' in gapDeviation).toBe(false);
    const updateDeviation = cycle.knowledgeDeviations.find((one) => one.sourceKind === 'learning_update')!;
    expect(updateDeviation.sourceRef).toBe(worldLearn.updateOne.id);
    expect(updateDeviation.snapshotRef).toBeNull();

    // The cycle is readable through the deep read with the same split.
    const deep = await loop.getLoopCycle(learn, { cycleId: cycle.id });
    expect(deep.realityDeviations).toHaveLength(4);
    expect(deep.knowledgeDeviations).toHaveLength(2);
    expect(deep.signals).toHaveLength(0);
  });

  it('THE CLASS LOCK at the service boundary: the other class shape refuses with NOTHING appended', async () => {
    const errer = member(tenantErr);
    const before = await loop.listLoopCycles(errer, {});

    // A REALITY-shaped deviation (expected/observed) submitted as a
    // knowledge deviation — refused.
    await expectCode('invalid_deviation_input', () =>
      loop.recordLoopCycle(errer, {
        goalId: worldErr.goal.id,
        predictedScore: 0.5,
        rationale: 'reality shape in the knowledge class',
        knowledgeDeviations: [
          { sourceKind: 'coverage_gap', sourceRef: worldErr.gapOne.id, snapshotId: worldErr.snapshotOne.id, expected: 0.5, observed: 0.2, note: 'wrong class' },
        ],
      }),
    );
    // A KNOWLEDGE-shaped deviation (severity/snapshotId) submitted as a
    // reality deviation — refused.
    await expectCode('invalid_deviation_input', () =>
      loop.recordLoopCycle(errer, {
        goalId: worldErr.goal.id,
        predictedScore: 0.5,
        rationale: 'knowledge shape in the reality class',
        realityDeviations: [
          { sourceKind: 'fabric_lease', sourceRef: worldErr.lease.id, severity: 0.7, snapshotId: worldErr.snapshotOne.id, expected: 0.5, observed: 0.2, note: 'wrong class' },
        ],
      }),
    );
    // Nothing was appended by either refusal.
    expect(await loop.listLoopCycles(errer, {})).toHaveLength(before.length);
  });

  it('cycle numbers are 1-based, monotonic and per (tenant, goal)', async () => {
    const errer = member(tenantErr);
    const first = await at(plusMinutes(T_ERR_BASE, 0), () =>
      loop.recordLoopCycle(errer, {
        goalId: worldErr.goal.id,
        predictedScore: 0.4,
        rationale: 'numbering one',
      }),
    );
    const second = await at(plusMinutes(T_ERR_BASE, 1), () =>
      loop.recordLoopCycle(errer, {
        goalId: worldErr.goal.id,
        predictedScore: 0.4,
        rationale: 'numbering two',
      }),
    );
    // A DIFFERENT goal in the SAME tenant starts at 1 again.
    const otherGoal = await at(plusMinutes(T_ERR_BASE, 2), () =>
      loop.recordLoopCycle(errer, {
        goalId: worldErrOtherGoal.id,
        predictedScore: 0.4,
        rationale: 'other goal numbering',
      }),
    );
    expect(first.cycleNumber).toBe(1);
    expect(second.cycleNumber).toBe(2);
    expect(otherGoal.cycleNumber).toBe(1);
    // The honest empty cycle: no deviations at all.
    expect(second.realityDeviations).toEqual([]);
    expect(second.knowledgeDeviations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The evidence gates — every citation resolves on its owning seam
// ---------------------------------------------------------------------------

describe('recordLoopCycle — the seam evidence gates (typed, nothing appended on refusal)', () => {
  it('refuses run citations that do not resolve on the plan (run_not_found)', async () => {
    const errer = member(tenantErr);
    const before = await loop.listLoopCycles(errer, {});
    // A REAL run of the same tenant, recorded on a DIFFERENT plan.
    await expectCode('run_not_found', () =>
      loop.recordLoopCycle(errer, {
        goalId: worldErr.goal.id,
        predictedScore: 0.5,
        rationale: 'wrong plan',
        realityDeviations: [
          { sourceKind: 'execution_run', sourceRef: runErrB.id, planId: worldErr.plan.id, expected: 0.5, observed: 0.2, note: 'run of another plan' },
        ],
      }),
    );
    // A missing run id on the right plan.
    await expectCode('run_not_found', () =>
      loop.recordLoopCycle(errer, {
        goalId: worldErr.goal.id,
        predictedScore: 0.5,
        rationale: 'missing run',
        realityDeviations: [
          { sourceKind: 'execution_run', sourceRef: newId(), planId: worldErr.plan.id, expected: 0.5, observed: 0.2, note: 'no such run' },
        ],
      }),
    );
    // A missing plan id.
    await expectCode('run_not_found', () =>
      loop.recordLoopCycle(errer, {
        goalId: worldErr.goal.id,
        predictedScore: 0.5,
        rationale: 'missing plan',
        realityDeviations: [
          { sourceKind: 'execution_run', sourceRef: worldErr.run.id, planId: newId(), expected: 0.5, observed: 0.2, note: 'no such plan' },
        ],
      }),
    );
    expect(await loop.listLoopCycles(errer, {})).toHaveLength(before.length);
  });

  it('refuses missing fabric leases, recommendations, gaps and learning updates uniformly', async () => {
    const errer = member(tenantErr);
    const before = await loop.listLoopCycles(errer, {});
    await expectCode('lease_not_found', () =>
      loop.recordLoopCycle(errer, {
        goalId: worldErr.goal.id,
        predictedScore: 0.5,
        rationale: 'missing lease',
        realityDeviations: [
          { sourceKind: 'fabric_lease', sourceRef: newId(), expected: 0.5, observed: 0.2, note: 'no such lease' },
        ],
      }),
    );
    await expectCode('recommendation_not_found', () =>
      loop.recordLoopCycle(errer, {
        goalId: worldErr.goal.id,
        predictedScore: 0.5,
        rationale: 'missing recommendation',
        realityDeviations: [
          { sourceKind: 'org_calibration', sourceRef: newId(), expected: 0.5, observed: 0.2, note: 'no such recommendation' },
        ],
      }),
    );
    // A REAL gap of the same tenant, cited through the WRONG snapshot.
    await expectCode('gap_not_found', () =>
      loop.recordLoopCycle(errer, {
        goalId: worldErr.goal.id,
        predictedScore: 0.5,
        rationale: 'wrong snapshot',
        knowledgeDeviations: [
          { sourceKind: 'coverage_gap', sourceRef: gapErrTwo.id, snapshotId: worldErr.snapshotOne.id, severity: 0.6, note: 'gap of another snapshot' },
        ],
      }),
    );
    await expectCode('gap_not_found', () =>
      loop.recordLoopCycle(errer, {
        goalId: worldErr.goal.id,
        predictedScore: 0.5,
        rationale: 'missing gap',
        knowledgeDeviations: [
          { sourceKind: 'coverage_gap', sourceRef: newId(), snapshotId: worldErr.snapshotOne.id, severity: 0.6, note: 'no such gap' },
        ],
      }),
    );
    await expectCode('learning_update_not_found', () =>
      loop.recordLoopCycle(errer, {
        goalId: worldErr.goal.id,
        predictedScore: 0.5,
        rationale: 'missing learning update',
        knowledgeDeviations: [
          { sourceKind: 'learning_update', sourceRef: newId(), severity: 0.6, note: 'no such update' },
        ],
      }),
    );
    expect(await loop.listLoopCycles(errer, {})).toHaveLength(before.length);
  });

  it('refuses missing and archived subject goals (goal_not_found / goal_not_active)', async () => {
    const errer = member(tenantErr);
    const before = await loop.listLoopCycles(errer, {});
    await expectCode('goal_not_found', () =>
      loop.recordLoopCycle(errer, {
        goalId: newId(),
        predictedScore: 0.5,
        rationale: 'no such goal',
      }),
    );
    await expectCode('goal_not_active', () =>
      loop.recordLoopCycle(errer, {
        goalId: goalErrArchived.id,
        predictedScore: 0.5,
        rationale: 'archived goal',
      }),
    );
    await expectCode('invalid_cycle_input', () =>
      loop.recordLoopCycle(errer, { goalId: worldErr.goal.id, rationale: 'no prediction' }),
    );
    expect(await loop.listLoopCycles(errer, {})).toHaveLength(before.length);
  });
});

// ---------------------------------------------------------------------------
// Acceptance clause 2 — learning changes future ranking without
// silently overriding policy
// ---------------------------------------------------------------------------

describe('applyRankingSignal — the policy-safe learning application', () => {
  let cycleErr: LoopCycle;

  beforeAll(async () => {
    const errer = member(tenantErr);
    cycleErr = await at(plusMinutes(T_ERR_BASE, 10), () =>
      loop.recordLoopCycle(errer, {
        goalId: worldErr.goal.id,
        predictedScore: 0.5,
        rationale: 'the signal cycle',
        realityDeviations: [
          { sourceKind: 'goal_metric', sourceRef: worldErr.goal.id, expected: 0.5, observed: 0.2, note: 'underdelivered' },
        ],
      }),
    );
  });

  it('records signals on all three ranking input channels, authoritative:false MINTED', async () => {
    const errer = member(tenantErr, 'signal-recorder');
    const infoSignal = await at(plusMinutes(T_ERR_BASE, 11), () =>
      loop.applyRankingSignal(errer, {
        cycleId: cycleErr.id,
        targetSeam: 'info_strategy',
        targetRef: worldErr.strategy.id,
        direction: 'lower',
        magnitude: 0.3,
        basis: 'reality_deviation',
        rationale: 'the strategy overweighted the spring context',
      }),
    );
    const orgSignal = await at(plusMinutes(T_ERR_BASE, 12), () =>
      loop.applyRankingSignal(errer, {
        cycleId: cycleErr.id,
        targetSeam: 'org_lab',
        targetRef: worldErr.candidate.id,
        direction: 'lower',
        magnitude: 0.25,
        basis: 'reality_deviation',
        rationale: 'the recommended crew overestimated',
      }),
    );
    const modelSignal = await at(plusMinutes(T_ERR_BASE, 13), () =>
      loop.applyRankingSignal(errer, {
        cycleId: cycleErr.id,
        targetSeam: 'company_model',
        targetRef: `source:${worldErr.sourceUuid}`,
        direction: 'raise',
        magnitude: 0.4,
        basis: 'knowledge_deviation',
        rationale: 'the source prior was wrong — raise its correction weight',
      }),
    );
    for (const signal of [infoSignal, orgSignal, modelSignal]) {
      expect(signal.authoritative).toBe(false);
      expect(signal.tenantId).toBe(tenantErr);
      expect(signal.recordedBy).toBe('signal-recorder');
    }
    expect(infoSignal.cycleId).toBe(cycleErr.id);
    expect(orgSignal.targetRef).toBe(worldErr.candidate.id);
    expect(modelSignal.targetRef).toBe(`source:${worldErr.sourceUuid}`);

    // The signals are reviewable through the read surface with every
    // filter, newest first.
    const all = await loop.listRankingSignals(errer, { cycleId: cycleErr.id });
    expect(all).toHaveLength(3);
    expect(all.map((one) => one.targetSeam)).toEqual(['company_model', 'org_lab', 'info_strategy']);
    const bySeam = await loop.listRankingSignals(errer, { targetSeam: 'info_strategy' });
    expect(bySeam.every((one) => one.targetSeam === 'info_strategy')).toBe(true);
    const byBasis = await loop.listRankingSignals(errer, { basis: 'knowledge_deviation' });
    expect(byBasis.map((one) => one.id)).toEqual([modelSignal.id]);
    const byGoal = await loop.listRankingSignals(errer, { goalId: worldErr.goal.id });
    expect(byGoal).toHaveLength(3);
    for (const signal of byGoal) {
      expect(signal.authoritative).toBe(false);
    }
  });

  it('refuses policy/settings/authority-shaped targets on BOTH surfaces, nothing appended', async () => {
    const errer = member(tenantErr);
    const before = await loop.listRankingSignals(errer, {});
    for (const word of ['policy', 'settings', 'authority', 'action_policy', 'authority_policy', 'actions']) {
      await expectCode('policy_mutation_refused', () =>
        loop.applyRankingSignal(errer, {
          cycleId: cycleErr.id,
          targetSeam: word,
          targetRef: 'anything',
          direction: 'raise',
          magnitude: 0.5,
          basis: 'reality_deviation',
          rationale: 'try to touch policy',
        }),
      );
    }
    // The query surface refuses the same vocabulary. (The typed query
    // cannot even EXPRESS the policy word — the cast reaches the
    // runtime validator the untyped boundary would hit.)
    await expectCode('policy_mutation_refused', () =>
      loop.listRankingSignals(errer, { targetSeam: 'settings' } as never),
    );
    expect(await loop.listRankingSignals(errer, {})).toHaveLength(before.length);
  });

  it('refuses target mismatches and unknown targets with the mapped typed codes', async () => {
    const errer = member(tenantErr);
    const before = await loop.listRankingSignals(errer, {});
    // A strategy of a DIFFERENT goal than the cycle's.
    await expectCode('strategy_goal_mismatch', () =>
      loop.applyRankingSignal(errer, {
        cycleId: cycleErr.id,
        targetSeam: 'info_strategy',
        targetRef: strategyErrOtherGoal.id,
        direction: 'raise',
        magnitude: 0.4,
        basis: 'reality_deviation',
        rationale: "another goal's strategy",
      }),
    );
    await expectCode('strategy_not_found', () =>
      loop.applyRankingSignal(errer, {
        cycleId: cycleErr.id,
        targetSeam: 'info_strategy',
        targetRef: newId(),
        direction: 'raise',
        magnitude: 0.4,
        basis: 'reality_deviation',
        rationale: 'no such strategy',
      }),
    );
    await expectCode('candidate_not_found', () =>
      loop.applyRankingSignal(errer, {
        cycleId: cycleErr.id,
        targetSeam: 'org_lab',
        targetRef: newId(),
        direction: 'raise',
        magnitude: 0.4,
        basis: 'reality_deviation',
        rationale: 'no such candidate',
      }),
    );
    // A company-model target that is not a subject key.
    await expectCode('invalid_signal_input', () =>
      loop.applyRankingSignal(errer, {
        cycleId: cycleErr.id,
        targetSeam: 'company_model',
        targetRef: 'spaceship:enterprise',
        direction: 'raise',
        magnitude: 0.4,
        basis: 'reality_deviation',
        rationale: 'not a subject kind',
      }),
    );
    // A missing cycle.
    await expectCode('cycle_not_found', () =>
      loop.applyRankingSignal(errer, {
        cycleId: newId(),
        targetSeam: 'org_lab',
        targetRef: worldErr.candidate.id,
        direction: 'raise',
        magnitude: 0.4,
        basis: 'reality_deviation',
        rationale: 'no such cycle',
      }),
    );
    expect(await loop.listRankingSignals(errer, {})).toHaveLength(before.length);
  });

  it('RECORDING SIGNALS NEVER TOUCHES THE TARGET SEAMS (no silent override)', async () => {
    const learn = member(tenantLearn);
    const strategyBefore = await getStrategy(learn, { strategyId: worldLearn.strategy.id });
    const candidateBefore = await getCandidate(learn, { candidateId: worldLearn.candidate.id });
    const rankingBefore = await rankCandidates(learn, {
      domain: 'source_selection',
      candidates: [{ kind: 'source', id: worldLearn.sourceUuid, label: 'Ops feed', baseScore: 0.5 }],
    });

    // An open cycle, then one signal on EACH of the three ranking input
    // channels: no seam state change may result.
    const cycle = await at(plusMinutes(T_LEARN_BASE, 1), () =>
      loop.recordLoopCycle(learn, {
        goalId: worldLearn.goal.id,
        predictedScore: 0.5,
        rationale: 'the seam-reception probe cycle',
        realityDeviations: [
          { sourceKind: 'goal_metric', sourceRef: worldLearn.goal.id, expected: 0.5, observed: 0.2, note: 'underdelivered' },
        ],
      }),
    );
    await at(plusMinutes(T_LEARN_BASE, 2), () =>
      loop.applyRankingSignal(learn, {
        cycleId: cycle.id,
        targetSeam: 'info_strategy',
        targetRef: worldLearn.strategy.id,
        direction: 'lower',
        magnitude: 0.3,
        basis: 'reality_deviation',
        rationale: 'the strategy overweighted the context',
      }),
    );
    await at(plusMinutes(T_LEARN_BASE, 3), () =>
      loop.applyRankingSignal(learn, {
        cycleId: cycle.id,
        targetSeam: 'org_lab',
        targetRef: worldLearn.candidate.id,
        direction: 'lower',
        magnitude: 0.3,
        basis: 'reality_deviation',
        rationale: 'the crew overestimated',
      }),
    );
    await at(plusMinutes(T_LEARN_BASE, 4), () =>
      loop.applyRankingSignal(learn, {
        cycleId: cycle.id,
        targetSeam: 'company_model',
        targetRef: `source:${worldLearn.sourceUuid}`,
        direction: 'lower',
        magnitude: 0.3,
        basis: 'reality_deviation',
        rationale: 'the prior was wrong',
      }),
    );

    // The target seams' own state is VERBATIM unchanged: the signals
    // are advisory records addressed to the channels, never mutations.
    const strategyAfter = await getStrategy(learn, { strategyId: worldLearn.strategy.id });
    expect(strategyAfter.currentVersion).toBe(strategyBefore.currentVersion);
    expect(strategyAfter.content).toEqual(strategyBefore.content);
    expect(strategyAfter.status).toBe(strategyBefore.status);
    const candidateAfter = await getCandidate(learn, { candidateId: worldLearn.candidate.id });
    expect(candidateAfter).toEqual(candidateBefore);
    const rankingAfter = await rankCandidates(learn, {
      domain: 'source_selection',
      candidates: [{ kind: 'source', id: worldLearn.sourceUuid, label: 'Ops feed', baseScore: 0.5 }],
    });
    expect(rankingAfter.modelVersion).toBe(rankingBefore.modelVersion);
    expect(rankingAfter.candidates).toEqual(rankingBefore.candidates);
    // No learning update was minted by the loop either.
    const updates = await listLearningUpdates(learn, { limit: 200 });
    expect(updates.map((one) => one.id)).toEqual([worldLearn.updateOne.id]);

    // Close the probe cycle so later counts stay deterministic.
    await at(plusMinutes(T_LEARN_BASE, 5), () =>
      loop.closeLoopCycle(learn, { cycleId: cycle.id, note: 'the seam-reception probe closes' }),
    );
  });

  it('the CompanyModel ranking changes ONLY through its own recorded channel, policy authoritative', async () => {
    const learn = member(tenantLearn);
    // BEFORE: the fixture prior (score 0.85, confidence 0.8) blends
    // into the base 0.5 → 0.78.
    const before = await rankCandidates(learn, {
      domain: 'source_selection',
      candidates: [{ kind: 'source', id: worldLearn.sourceUuid, label: 'Ops feed', baseScore: 0.5 }],
    });
    expect(before.candidates[0]!.score).toBe(0.78);
    expect(before.candidates[0]!.learnedScore).toBe(0.85);

    // THE EXPLICIT RECORDED LEARNING UPDATE (the CompanyModel's own
    // channel — an auditable operation with rationale, NOT the loop's
    // signal): the source's reliability prior is revised DOWN.
    const revision = await at(T_UPDATE_TWO, () =>
      recordLearningUpdate(learn, {
        changes: [
          {
            area: 'source_reliability',
            subject: { kind: 'source', id: worldLearn.sourceUuid, label: 'Ops feed' },
            topic: 'reliability',
            statement: { score: 0.25, note: 'revised after the loop cycles' },
            confidence: 0.9,
            disposition: 'asserted',
            validFrom: null,
            validUntil: null,
            evidence: [
              { kind: 'observation', id: worldLearn.snapshotOne.id, label: 'the ops-tickets freshness observation' },
            ],
            outcomeId: null,
          },
        ],
        rationale: 'the loop cycles showed the source underdelivering — revise the prior',
        actor: { kind: 'person', label: 'ops lead' },
      }),
    );
    expect(revision.modelVersion).toBe(2);

    // AFTER: the FUTURE RANKING changed — 0.5*(1−0.9) + 0.25*0.9 = 0.275.
    const after = await rankCandidates(learn, {
      domain: 'source_selection',
      candidates: [{ kind: 'source', id: worldLearn.sourceUuid, label: 'Ops feed', baseScore: 0.5 }],
    });
    expect(after.modelVersion).toBe(2);
    expect(after.candidates[0]!.score).toBe(0.275);
    expect(after.candidates[0]!.learnedScore).toBe(0.25);
    expect(after.candidates[0]!.appliedPrior).toMatchObject({ version: 2, confidence: 0.9 });

    // EXPLICIT POLICY STAYS AUTHORITATIVE over the learned prior: a
    // kind the policy does not allow ranks last no matter how reliable
    // it learned to be.
    const policed = await rankCandidates(learn, {
      domain: 'source_selection',
      candidates: [
        { kind: 'source', id: worldLearn.sourceUuid, label: 'Ops feed', baseScore: 0.5 },
        { kind: 'term', name: 'churn', label: 'Churn', baseScore: 0.1 },
      ],
      policy: { allowedKinds: ['term'] },
    });
    expect(policed.candidates[0]!.kind).toBe('term');
    expect(policed.candidates[0]!.policyExcluded).toBe(false);
    expect(policed.candidates[1]!.kind).toBe('source');
    expect(policed.candidates[1]!.policyExcluded).toBe(true);
    expect(policed.candidates[1]!.score).toBe(0.275); // learned, yet excluded

    // The loop's own record of the same learning: the signal addressed
    // to the CompanyModel remains advisory and reviewable — it did not
    // perform this change, the recorded update did.
    const modelSignals = await loop.listRankingSignals(learn, { targetSeam: 'company_model' });
    expect(modelSignals).toHaveLength(1);
    expect(modelSignals[0]!.authoritative).toBe(false);
    expect(modelSignals[0]!.targetRef).toBe(`source:${worldLearn.sourceUuid}`);
  });
});

// ---------------------------------------------------------------------------
// closeLoopCycle — the one-way transition with the frozen metrics
// ---------------------------------------------------------------------------

describe('closeLoopCycle — the one-way transition and the frozen metrics', () => {
  it('freezes the deterministic metrics exactly once and refuses the second close', async () => {
    const errer = member(tenantErr, 'closer');
    const cycle = await at(plusMinutes(T_ERR_BASE, 20), () =>
      loop.recordLoopCycle(errer, {
        goalId: worldErr.goal.id,
        predictedScore: 0.5,
        rationale: 'the close-proof cycle',
        realityDeviations: [
          { sourceKind: 'goal_metric', sourceRef: worldErr.goal.id, expected: 0.5, observed: 0.2, note: 'miss' },
          { sourceKind: 'execution_run', sourceRef: worldErr.run.id, planId: worldErr.plan.id, expected: 0.5, observed: 0.4, note: 'run below expectation' },
        ],
        knowledgeDeviations: [
          { sourceKind: 'coverage_gap', sourceRef: worldErr.gapOne.id, snapshotId: worldErr.snapshotOne.id, severity: 0.7, note: 'stale ops evidence' },
        ],
      }),
    );
    expect(cycle.metrics).toBeNull();

    const closed = await at(plusMinutes(T_ERR_BASE, 21), () =>
      loop.closeLoopCycle(errer, { cycleId: cycle.id, note: 'cycle one closes' }),
    );
    // observedScore = mean([0.2, 0.4]) = 0.3; calibrationError = 0.2;
    // no previous closed cycle of this goal → recurrence null;
    // no previous knowledge sources → closure null.
    expect(closed.status).toBe('closed');
    expect(closed.metrics).toEqual({
      observedScore: 0.3,
      calibrationError: 0.2,
      gapClosureRate: null,
      deviationRecurrence: null,
      realityCount: 2,
      knowledgeCount: 1,
    });
    expect(closed.closedAt).toBe(plusMinutes(T_ERR_BASE, 21));
    expect(closed.closedBy).toBe('closer');
    expect(closed.closeNote).toBe('cycle one closes');

    // The one-way terminal: a second close refuses.
    await expectCode('cycle_already_closed', () =>
      loop.closeLoopCycle(errer, { cycleId: cycle.id, note: 'close again' }),
    );
    // Signals refuse on the closed cycle, nothing appended.
    const signalsBefore = await loop.listRankingSignals(errer, {});
    await expectCode('cycle_not_open', () =>
      loop.applyRankingSignal(errer, {
        cycleId: cycle.id,
        targetSeam: 'org_lab',
        targetRef: worldErr.candidate.id,
        direction: 'raise',
        magnitude: 0.4,
        basis: 'reality_deviation',
        rationale: 'too late',
      }),
    );
    expect(await loop.listRankingSignals(errer, {})).toHaveLength(signalsBefore.length);

    // The next cycle of the same goal closes with the recurrence and
    // closure computed against THIS closed one.
    const next = await at(plusMinutes(T_ERR_BASE, 22), () =>
      loop.recordLoopCycle(errer, {
        goalId: worldErr.goal.id,
        predictedScore: 0.45,
        rationale: 'the recurrence-proof cycle',
        realityDeviations: [
          { sourceKind: 'goal_metric', sourceRef: worldErr.goal.id, expected: 0.45, observed: 0.3, note: 'miss again' },
        ],
        knowledgeDeviations: [
          { sourceKind: 'coverage_gap', sourceRef: gapErrTwo.id, snapshotId: snapshotErrTwo.id, severity: 0.5, note: 'a different gap' },
        ],
      }),
    );
    const nextClosed = await at(plusMinutes(T_ERR_BASE, 23), () =>
      loop.closeLoopCycle(errer, { cycleId: next.id, note: 'cycle two closes' }),
    );
    // Previous reality sources: [goal, run]; this cycle's: [goal] →
    // recurrence 1. Previous knowledge: [gapOne]; this: [gapTwo] → no
    // recurrence → closure 1.
    expect(nextClosed.metrics).toEqual({
      observedScore: 0.3,
      calibrationError: 0.15,
      gapClosureRate: 1,
      deviationRecurrence: 1,
      realityCount: 1,
      knowledgeCount: 1,
    });
  });

  it('the unmeasured cycle stays honestly unmeasured (nulls, never defaults)', async () => {
    const errer = member(tenantErr);
    const cycle = await at(plusMinutes(T_ERR_BASE, 30), () =>
      loop.recordLoopCycle(errer, {
        goalId: worldErrOtherGoal.id,
        predictedScore: 0.6,
        rationale: 'an honest empty cycle',
      }),
    );
    const closed = await at(plusMinutes(T_ERR_BASE, 31), () =>
      loop.closeLoopCycle(errer, { cycleId: cycle.id, note: 'nothing was measured' }),
    );
    expect(closed.metrics).toEqual({
      observedScore: null,
      calibrationError: null,
      gapClosureRate: null,
      deviationRecurrence: null,
      realityCount: 0,
      knowledgeCount: 0,
    });
    // The summary refuses to fabricate an improvement.
    const summary = await loop.summarizeLoopImprovement(errer, { goalId: worldErrOtherGoal.id });
    expect(summary.verdict).toBe('insufficient_evidence');
    expect(summary.closedCycleCount).toBe(1);
    expect(summary.firstCalibrationError).toBeNull();
    expect(summary.lastCalibrationError).toBeNull();
    expect(summary.calibrationDelta).toBeNull();
    expect(summary.signalCount).toBe(0);
  });

  it('refuses missing cycles and malformed queries uniformly', async () => {
    const errer = member(tenantErr);
    await expectCode('cycle_not_found', () =>
      loop.closeLoopCycle(errer, { cycleId: newId(), note: 'no such cycle' }),
    );
    await expectCode('invalid_close_input', () =>
      loop.closeLoopCycle(errer, { cycleId: 'not-a-uuid', note: 'x' }),
    );
    await expectCode('cycle_not_found', () =>
      loop.getLoopCycle(errer, { cycleId: newId() }),
    );
    await expectCode('invalid_query', () =>
      loop.listLoopCycles(errer, { limit: 0 }),
    );
  });
});

// ---------------------------------------------------------------------------
// Acceptance clause 3 — longitudinal measurable improvement
// (the learning loop vs the control loop)
// ---------------------------------------------------------------------------

describe('the longitudinal measurable improvement (learning loop vs control)', () => {
  // The learning loop's frozen artifacts, shared with the assertions.
  const learningCycles: LoopCycle[] = [];
  const controlCycles: LoopCycle[] = [];

  it('runs the four-cycle learning loop: recorded signals adjust every next prediction', async () => {
    const learn = member(tenantLearn, 'loop-runner');
    let prediction = BASE_PREDICTION;

    for (let index = 0; index < CYCLE_COUNT; index += 1) {
      const cycleAt = plusMinutes(T_LEARN_BASE, 30 + index * 3);
      const cycle = await at(cycleAt, () =>
        loop.recordLoopCycle(learn, {
          goalId: worldLearn.goal.id,
          predictedScore: prediction,
          rationale: `learning cycle ${index + 1}`,
          realityDeviations: [
            { sourceKind: 'goal_metric', sourceRef: worldLearn.goal.id, expected: prediction, observed: WORLD_OBSERVED, note: 'the goal metric underdelivered' },
            { sourceKind: 'execution_run', sourceRef: worldLearn.run.id, planId: worldLearn.plan.id, expected: prediction, observed: WORLD_OBSERVED, note: 'the run underdelivered' },
          ],
          knowledgeDeviations:
            index === 0
              ? [{ sourceKind: 'coverage_gap', sourceRef: worldLearn.gapOne.id, snapshotId: worldLearn.snapshotOne.id, severity: 0.7, note: 'ops evidence was stale' }]
              : index === 1
                ? [{ sourceKind: 'coverage_gap', sourceRef: worldLearn.gapTwo!.id, snapshotId: worldLearn.snapshotTwo!.id, severity: 0.5, note: 'meeting evidence went stale' }]
                : [],
        }),
      );
      expect(cycle.predictedScore).toBe(EXPECTED_LEARN_PREDICTIONS[index]);

      // THE RECORDED LEARNING APPLICATION: the signal derived from this
      // cycle's calibration gap (direction + magnitude through the
      // exported deterministic derivation), addressed to the ranking
      // channel the cycle implicates. Cycles 1-3 derive signals; the
      // last cycle records none (a loop may close without learning).
      if (index < CYCLE_COUNT - 1) {
        const direction = deriveSignalDirection(prediction, WORLD_OBSERVED);
        const magnitude = deriveSignalMagnitude(prediction, WORLD_OBSERVED);
        const targetSeam = (['info_strategy', 'org_lab', 'company_model'] as const)[index];
        const targetRef =
          targetSeam === 'info_strategy'
            ? worldLearn.strategy.id
            : targetSeam === 'org_lab'
              ? worldLearn.candidate.id
              : `source:${worldLearn.sourceUuid}`;
        const signal = await at(plusMinutes(cycleAt, 1), () =>
          loop.applyRankingSignal(learn, {
            cycleId: cycle.id,
            targetSeam,
            targetRef,
            direction,
            magnitude,
            basis: 'reality_deviation',
            rationale: `cycle ${index + 1}: the world ${direction === 'raise' ? 'outperformed' : 'underperformed'} the prediction by ${magnitude}`,
          }),
        );
        learnSignals.push(signal);
        expect(signal.authoritative).toBe(false);
      }

      // Close the cycle and retain the CLOSED read (with the frozen
      // metrics) — the longitudinal assertions below consume the frozen
      // state, not the open snapshot.
      const closed = await at(plusMinutes(cycleAt, 2), () =>
        loop.closeLoopCycle(learn, { cycleId: cycle.id, note: `learning cycle ${index + 1} closed` }),
      );
      learningCycles.push(closed);

      // THE NEXT PREDICTION: the recorded signals applied to the base
      // through the exported single deterministic fold — never a
      // re-derivation, never a silent jump.
      prediction = applyRankingSignals(
        BASE_PREDICTION,
        learnSignals.map((one) => ({ direction: one.direction, magnitude: one.magnitude })),
      );
    }

    // The frozen calibration errors shrink strictly, cycle over cycle.
    const errors = learningCycles.map((one) => one.metrics!.calibrationError!);
    expect(errors).toEqual(EXPECTED_LEARN_ERRORS);
    for (let index = 1; index < errors.length; index += 1) {
      expect(errors[index]!, `cycle ${index + 1} must improve on cycle ${index}`).toBeLessThan(errors[index - 1]!);
    }
    // The knowledge side closed its gap: cycle 2's citation did not
    // recur from cycle 1.
    expect(learningCycles[1]!.metrics!.gapClosureRate).toBe(1);
  });

  it('runs the control loop over the same world WITHOUT signals: flat', async () => {
    const control = member(tenantControl, 'control-runner');
    for (let index = 0; index < CYCLE_COUNT; index += 1) {
      const cycleAt = plusMinutes(T_CONTROL_BASE, index * 2);
      const cycle = await at(cycleAt, () =>
        loop.recordLoopCycle(control, {
          goalId: worldControl.goal.id,
          predictedScore: BASE_PREDICTION,
          rationale: `control cycle ${index + 1} (no learning applied)`,
          realityDeviations: [
            { sourceKind: 'goal_metric', sourceRef: worldControl.goal.id, expected: BASE_PREDICTION, observed: WORLD_OBSERVED, note: 'the goal metric underdelivered' },
            { sourceKind: 'execution_run', sourceRef: worldControl.run.id, planId: worldControl.plan.id, expected: BASE_PREDICTION, observed: WORLD_OBSERVED, note: 'the run underdelivered' },
          ],
        }),
      );
      // Retain the CLOSED read — the flat-errors assertion consumes the
      // frozen metrics, not the open snapshot.
      const closed = await at(plusMinutes(cycleAt, 1), () =>
        loop.closeLoopCycle(control, { cycleId: cycle.id, note: `control cycle ${index + 1} closed` }),
      );
      controlCycles.push(closed);
    }
    // No signal was ever recorded; every error stays at 0.3.
    const errors = controlCycles.map((one) => one.metrics!.calibrationError!);
    expect(errors).toEqual([0.3, 0.3, 0.3, 0.3]);
    expect(await loop.listRankingSignals(control, {})).toHaveLength(0);
  });

  it('the trajectory carries the cycle-over-cycle series of the CLOSED cycles, ascending', async () => {
    const learn = member(tenantLearn);
    const control = member(tenantControl);
    // The learning goal holds six cycles: the full-evidence cycle 1
    // (still open — the live cycle), the seam-reception probe cycle 2,
    // and the four loop cycles 3-6. The trajectory is CLOSED-only.
    const trajectory = await loop.getLoopTrajectory(learn, { goalId: worldLearn.goal.id });
    expect(trajectory.goalId).toBe(worldLearn.goal.id);
    expect(trajectory.points.map((one) => one.cycleNumber)).toEqual([2, 3, 4, 5, 6]);
    expect(trajectory.points.map((one) => one.calibrationError)).toEqual([0.3, ...EXPECTED_LEARN_ERRORS]);
    expect(trajectory.points.map((one) => one.signalCount)).toEqual([3, 1, 1, 1, 0]);
    expect(trajectory.points.every((one) => one.observedScore === WORLD_OBSERVED)).toBe(true);

    const controlTrajectory = await loop.getLoopTrajectory(control, { goalId: worldControl.goal.id });
    expect(controlTrajectory.points.map((one) => one.cycleNumber)).toEqual([1, 2, 3, 4]);
    expect(controlTrajectory.points.map((one) => one.calibrationError)).toEqual([0.3, 0.3, 0.3, 0.3]);
    expect(controlTrajectory.points.map((one) => one.signalCount)).toEqual([0, 0, 0, 0]);
  });

  it('the summary states the honest verdicts: improved vs flat', async () => {
    const learn = member(tenantLearn);
    const control = member(tenantControl);
    const improved = await loop.summarizeLoopImprovement(learn, { goalId: worldLearn.goal.id });
    expect(improved.verdict).toBe('improved');
    expect(improved.closedCycleCount).toBe(5);
    expect(improved.firstCalibrationError).toBe(0.3);
    expect(improved.lastCalibrationError).toBe(EXPECTED_LEARN_ERRORS[3]!);
    expect(improved.calibrationDelta).toBe(0.1734); // round4(0.3 − 0.1266)
    expect(improved.signalCount).toBe(6); // 3 probe + 3 loop signals
    expect(improved.recurrenceFirst).toBeNull();
    expect(improved.recurrenceLast).toBe(1);
    expect(improved.gapClosureMean).toBe(1); // the two measured closures

    const flat = await loop.summarizeLoopImprovement(control, { goalId: worldControl.goal.id });
    expect(flat.verdict).toBe('flat');
    expect(flat.calibrationDelta).toBe(0);
    expect(flat.signalCount).toBe(0);
    expect(flat.recurrenceLast).toBe(1);
  });

  it('the lists filter by goal and status, newest first', async () => {
    const learn = member(tenantLearn);
    const forGoal = await loop.listLoopCycles(learn, { goalId: worldLearn.goal.id });
    expect(forGoal).toHaveLength(6);
    expect(forGoal[0]!.cycleNumber).toBe(6);
    expect(forGoal[0]!.status).toBe('closed');
    expect(forGoal[0]!.calibrationError).toBe(EXPECTED_LEARN_ERRORS[3]!);
    expect(forGoal[5]!.cycleNumber).toBe(1);
    expect(forGoal[5]!.status).toBe('open');
    expect(forGoal[5]!.calibrationError).toBeNull();
    expect(forGoal.filter((one) => one.status === 'closed')).toHaveLength(5);
    const open = await loop.listLoopCycles(learn, { status: 'open' });
    expect(open).toHaveLength(1);
    expect(open[0]!.cycleNumber).toBe(1);
    const control = member(tenantControl);
    expect(await loop.listLoopCycles(control, { goalId: worldControl.goal.id })).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation (ADR-0001)
// ---------------------------------------------------------------------------

describe('tenant isolation — two tenants hold fully independent loops', () => {
  let cycleIsoA: LoopCycle;
  let cycleIsoB: LoopCycle;

  beforeAll(async () => {
    const isoA = member(tenantIsoA);
    const isoB = member(tenantIsoB);
    cycleIsoA = await at(plusMinutes(T_ISO_BASE, 0), () =>
      loop.recordLoopCycle(isoA, {
        goalId: worldIsoA.goal.id,
        predictedScore: 0.5,
        rationale: 'the isolation cycle A',
        realityDeviations: [
          { sourceKind: 'goal_metric', sourceRef: worldIsoA.goal.id, expected: 0.5, observed: 0.2, note: 'miss' },
        ],
        knowledgeDeviations: [
          { sourceKind: 'coverage_gap', sourceRef: worldIsoA.gapOne.id, snapshotId: worldIsoA.snapshotOne.id, severity: 0.6, note: 'stale' },
        ],
      }),
    );
    await at(plusMinutes(T_ISO_BASE, 1), () =>
      loop.applyRankingSignal(isoA, {
        cycleId: cycleIsoA.id,
        targetSeam: 'company_model',
        targetRef: `source:${worldIsoA.sourceUuid}`,
        direction: 'lower',
        magnitude: 0.3,
        basis: 'reality_deviation',
        rationale: 'the A prior was wrong',
      }),
    );
    // The same-shaped cycle in tenant B, citing B's OWN evidence.
    cycleIsoB = await at(plusMinutes(T_ISO_BASE, 2), () =>
      loop.recordLoopCycle(isoB, {
        goalId: worldIsoB.goal.id,
        predictedScore: 0.5,
        rationale: 'the isolation cycle B',
        realityDeviations: [
          { sourceKind: 'goal_metric', sourceRef: worldIsoB.goal.id, expected: 0.5, observed: 0.2, note: 'miss' },
        ],
        knowledgeDeviations: [
          { sourceKind: 'coverage_gap', sourceRef: worldIsoB.gapOne.id, snapshotId: worldIsoB.snapshotOne.id, severity: 0.6, note: 'stale' },
        ],
      }),
    );
  });

  it('foreign cycles are uniformly not-found and lists stay scoped', async () => {
    const isoB = member(tenantIsoB);
    await expectCode('cycle_not_found', () =>
      loop.getLoopCycle(isoB, { cycleId: cycleIsoA.id }),
    );
    await expectCode('cycle_not_found', () =>
      loop.closeLoopCycle(isoB, { cycleId: cycleIsoA.id, note: 'cross-tenant close' }),
    );
    await expectCode('cycle_not_found', () =>
      loop.applyRankingSignal(isoB, {
        cycleId: cycleIsoA.id,
        targetSeam: 'org_lab',
        targetRef: worldIsoB.candidate.id,
        direction: 'raise',
        magnitude: 0.4,
        basis: 'reality_deviation',
        rationale: 'cross-tenant signal',
      }),
    );
    const cyclesB = await loop.listLoopCycles(isoB, {});
    expect(cyclesB.map((one) => one.id)).toEqual([cycleIsoB.id]);
    // Neither deviations nor signals leak across the boundary.
    const signalsB = await loop.listRankingSignals(isoB, { goalId: worldIsoA.goal.id });
    expect(signalsB).toHaveLength(0);
    const trajectoryB = await loop.getLoopTrajectory(isoB, { goalId: worldIsoA.goal.id });
    expect(trajectoryB.points).toHaveLength(0);
    const summaryB = await loop.summarizeLoopImprovement(isoB, { goalId: worldIsoA.goal.id });
    expect(summaryB.closedCycleCount).toBe(0);
    expect(summaryB.verdict).toBe('insufficient_evidence');
  });

  it("foreign evidence is refused through the seams' own tenant scoping", async () => {
    const isoB = member(tenantIsoB);
    const before = await loop.listLoopCycles(isoB, {});
    // B's loop citing A's run — the agent-exchange read is B-scoped,
    // so A's run does not resolve: uniform mapped not-found.
    await expectCode('run_not_found', () =>
      loop.recordLoopCycle(isoB, {
        goalId: worldIsoB.goal.id,
        predictedScore: 0.5,
        rationale: "cite the other tenant's run",
        realityDeviations: [
          { sourceKind: 'execution_run', sourceRef: worldIsoA.run.id, planId: worldIsoA.plan.id, expected: 0.5, observed: 0.2, note: 'foreign run' },
        ],
      }),
    );
    await expectCode('goal_not_found', () =>
      loop.recordLoopCycle(isoB, {
        goalId: worldIsoA.goal.id,
        predictedScore: 0.5,
        rationale: "cite the other tenant's goal",
      }),
    );
    expect(await loop.listLoopCycles(isoB, {})).toHaveLength(before.length);
  });

  it('same-shaped loops coexist with independent numbering and closings', async () => {
    const isoA = member(tenantIsoA);
    const isoB = member(tenantIsoB);
    expect(cycleIsoA.cycleNumber).toBe(1);
    expect(cycleIsoB.cycleNumber).toBe(1);
    const closedA = await at(plusMinutes(T_ISO_BASE, 5), () =>
      loop.closeLoopCycle(isoA, { cycleId: cycleIsoA.id, note: 'A closes' }),
    );
    const closedB = await at(plusMinutes(T_ISO_BASE, 6), () =>
      loop.closeLoopCycle(isoB, { cycleId: cycleIsoB.id, note: 'B closes' }),
    );
    expect(closedA.metrics!.calibrationError).toBe(0.3);
    expect(closedB.metrics!.calibrationError).toBe(0.3);
    // A's signal is visible only to A.
    const signalsA = await loop.listRankingSignals(isoA, {});
    expect(signalsA).toHaveLength(1);
    expect(signalsA[0]!.cycleId).toBe(cycleIsoA.id);
  });
});

// ---------------------------------------------------------------------------
// The storage laws — append-only evidence, immutable spine (direct SQL
// probes: the deliberate exception proving the schema's own laws)
// ---------------------------------------------------------------------------

describe('the storage laws (direct SQL probes)', () => {
  it('the three evidence tables are append-only: UPDATE/DELETE/TRUNCATE rejected', async () => {
    const db = getDb();
    await expect(
      db.query(`UPDATE loop_reality_deviations SET note = 'forged'`),
    ).rejects.toThrow(/append-only/);
    await expect(
      db.query(`DELETE FROM loop_knowledge_deviations`),
    ).rejects.toThrow(/append-only/);
    await expect(
      db.query(`TRUNCATE loop_ranking_signals`),
    ).rejects.toThrow(/append-only/);
  });

  it('the cycle spine is append-and-close: identity immutable, one-way, frozen', async () => {
    const db = getDb();
    await expect(
      db.query(`DELETE FROM loop_cycles`),
    ).rejects.toThrow(/append-and-close/);
    await expect(
      db.query(`UPDATE loop_cycles SET predicted_score = 0.99`),
    ).rejects.toThrow(/identity columns are immutable/);
    // Closed is terminal.
    await expect(
      db.query(`UPDATE loop_cycles SET status = 'open' WHERE status = 'closed'`),
    ).rejects.toThrow(/closed is terminal/);
    // The frozen metrics of a closed cycle cannot be rewritten.
    const learn = member(tenantLearn);
    const closed = (await loop.listLoopCycles(learn, { goalId: worldLearn.goal.id }))[0]!;
    await expect(
      db.query(`UPDATE loop_cycles SET calibration_error = 0.01 WHERE id = $1`, [closed.id]),
    ).rejects.toThrow(/frozen metrics are immutable/);
  });
});
