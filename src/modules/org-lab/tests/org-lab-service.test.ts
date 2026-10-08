// Integration tests for the org-lab module against the embedded PostgreSQL
// (PGlite, `:memory:`) through the db port. Covers the W135 acceptance
// (spec/work-items/WORK-ITEM-CATALOG.md §W135):
//
//   * ORGANIZATION SEARCH WITH THE CONTEXTUAL DIMENSIONS —
//     searchOrganizations ranks the tenant's ACTIVE candidates under a REAL
//     W134 ContextFingerprint (derived here through the context contract) and
//     every result carries the twelve-axis fit report (season/time window,
//     duration, staffing/staff experience, workload, capability,
//     environment, budget, quality, risk, verification, evidence freshness —
//     plus SLA), the deterministic fitScore/rankScore, the outcome-
//     calibration aggregate and the §5 node-kind census;
//   * REJECTED CANDIDATES ARE RETAINED — the append-only evaluation law:
//     a recommendation keeps EVERY evaluated candidate (recommended AND
//     rejected, rejection reasons included) through the candidate's own
//     retirement, and the storage triggers reject UPDATE/DELETE/TRUNCATE on
//     the evidence tables outright;
//   * RECOMMENDATIONS ARE OUTCOME-CALIBRATED — recordRecommendation commits
//     to OPEN learning-module outcomes BEFORE realization (the W054
//     prediction-hygiene discipline), recordCalibration consumes the
//     learning module's FROZEN realizations and stamps the one-way
//     recorded → calibrated transition under the row lock (terminal: one
//     calibration per recommendation, ever), and the calibrated evidence
//     then modulates the search arithmetically (positive evidence lifts a
//     candidate above its raw fit; a missed outcome drags it below);
//   * THE CONTEXTUAL RULE END TO END — the SAME candidates under two
//     materially different fingerprints (both derived for the SAME goal,
//     through the real W134 derivation path) rank a DIFFERENT candidate
//     first: the divergence is data, never code;
//   * TYPED ERROR PATHS — foreign ids read uniformly as their typed
//     not-found codes (no existence leak); invalid transitions
//     (double-retire, double-calibrate, calibrating unsettled outcomes)
//     are refused;
//   * TENANT ISOLATION (ADR-0001) — two tenants hold fully independent
//     Lab state: the same slug coexists, foreign reads are uniformly
//     not-found, and neither search nor lists leak across the boundary.
//
// TRANSACTION DISCIPLINE (the W134 lesson, binding): this harness NEVER
// opens a db.transaction of its own — the service opens exactly one
// transaction per mutation on the single PGlite connection, and a harness
// transaction around a service call would deadlock the embedded database.
// Every fixture below is built through the REAL public contracts (goals,
// context, epistemics, info-strategy, agents, agent-evaluation, learning,
// agent-body, provider-fabric — the full W135 seam map), never by direct
// SQL writes.

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
import {
  OrgLabError,
  getCandidate,
  getCandidateCalibration,
  getRecommendation,
  listCandidates,
  listRecommendations,
  recordCalibration,
  recordRecommendation,
  registerCandidate,
  retireCandidate,
  searchOrganizations,
} from '../contract';
import type { OrgLabErrorCode } from '../contract';

// The consumed seams, exercised as REAL records through their owning
// contracts (never re-derived, never direct-written):
//   goals W008 · context W134 · epistemics W004 · info-strategy W134 ·
//   agents W021 · agent-evaluation W024 · learning W040 ·
//   agent-body W133 · provider-fabric W132
import { createGoal, reviseGoal } from '@/modules/goals/contract';
import type { Goal } from '@/modules/goals/contract';
import { deriveFingerprint } from '@/modules/context/contract';
import type { ContextFingerprint } from '@/modules/context/contract';
import { defineStrategy } from '@/modules/info-strategy/contract';
import type { InfoStrategy } from '@/modules/info-strategy/contract';
import { recordUnknown } from '@/modules/epistemics/contract';
import { registerAgent } from '@/modules/agents/contract';
import type { RegisterAgentInput } from '@/modules/agents/contract';
import { recordAgentEvaluation } from '@/modules/agent-evaluation/contract';
import type { AgentEvaluation } from '@/modules/agent-evaluation/contract';
import {
  abandonOutcome,
  defineOutcome,
  recordMeasurement,
  settleOutcome,
} from '@/modules/learning/contract';
import type { Outcome } from '@/modules/learning/contract';
import {
  attachModelBinding as attachBodyBinding,
  createAgentBody,
  retireAgentBody,
} from '@/modules/agent-body/contract';
import type { AgentBody } from '@/modules/agent-body/contract';
import {
  attachModelBinding as attachFabricBinding,
  connectKnownProvider,
  registerModelManually,
} from '@/modules/provider-fabric/contract';
import type { ModelBinding, ProviderDefinition } from '@/modules/provider-fabric/contract';
import type {
  AgentDefinition,
} from '@/modules/agents/contract';

// Deterministic service-clock pins (the injectable clock discipline —
// same-millisecond writes must not decide what a proof shows).
const T_REC1 = '2026-10-07T09:00:00.000Z';
const T_CALIBRATE_1 = '2026-10-07T09:30:00.000Z';
const T_RETIRE_B = '2026-10-07T10:15:00.000Z';
const T_REC2 = '2026-10-07T11:00:00.000Z';
const T_CALIBRATE_2 = '2026-10-07T11:45:00.000Z';
const T_REC3 = '2026-10-07T12:30:00.000Z';

function pinClock(at: string): () => void {
  const realNow = systemClock.now;
  systemClock.now = () => new Date(at);
  return () => {
    systemClock.now = realNow;
  };
}

function member(
  tenantId: string,
  principalId = newId(),
  authority: string[] = [],
): TenantContext {
  return { tenantId, principalId, authority };
}

async function expectCode(
  code: OrgLabErrorCode,
  fn: () => Promise<unknown>,
): Promise<OrgLabError> {
  try {
    await fn();
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(OrgLabError);
    const typed = error as OrgLabError;
    expect(typed.code).toBe(code);
    return typed;
  }
}

// ---------------------------------------------------------------------------
// Fixture factories (all content caller-supplied — THE CONTEXTUAL RULE: no
// industry, season or workload semantics live in these helpers, only the
// exact strings the fixtures declare and observe)
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
    actor: { kind: 'system' as const, label: 'w135-test' },
  };
}

/** The spring observations (the richest honest fingerprint). */
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
    capabilities: { available: ['ride-dispatch', 'payments'], missing: [] },
    environment: { factors: ['urban', 'rainy-season'] },
    constraints: {
      budgetNote: 'lean budget',
      slaNote: '15m pickup SLA',
      qualityTarget: '4.8 stars',
      riskTolerance: 'risk-averse' as const,
      verificationRequirements: ['dual-signoff'],
    },
    evidenceFreshness: { maxEvidenceAge: '48h', criticalFreshSurfaces: ['traffic-api', 'weather-api'] },
  };
}

/** A materially different context for the SAME subject. */
function winterObservations() {
  return {
    season: { window: 'winter', note: null },
    duration: { durationClass: 'long' as const, estimatedSpan: '~5 months' },
    staffing: {
      headcount: 4,
      experienceMix: { novice: 0, intermediate: 1, expert: 3 },
      note: null,
    },
    workload: 'heavy' as const,
    capabilities: { available: ['freight-logistics'], missing: [] },
    environment: { factors: ['mountain', 'snow'] },
    constraints: {
      budgetNote: 'capital available',
      slaNote: '24h freight SLA',
      qualityTarget: 'zero damage',
      riskTolerance: 'risk-tolerant' as const,
      verificationRequirements: ['carrier-insurance'],
    },
    evidenceFreshness: { maxEvidenceAge: '24h', criticalFreshSurfaces: ['weather-api', 'road-status'] },
  };
}

/** Declares exactly what the spring observations show (all nine mechanical axes). */
function springDeclared() {
  return {
    seasonWindows: ['spring'],
    durationClasses: ['short' as const],
    staffingProfiles: ['novice-heavy' as const],
    workloadLevels: ['light' as const],
    requiredCapabilities: ['ride-dispatch'],
    requiredEnvironmentFactors: ['urban'],
    riskTolerances: ['risk-averse' as const],
    requiredVerificationRequirements: ['dual-signoff'],
    freshSurfaces: ['traffic-api'],
    budgetNote: 'cost-conscious crew',
    qualityTarget: 'high rating',
    slaNote: 'fast pickup',
  };
}

/** Declares the opposite of everything the spring observations show. */
function winterDeclared() {
  return {
    seasonWindows: ['winter'],
    durationClasses: ['long' as const],
    staffingProfiles: ['expert-heavy' as const],
    workloadLevels: ['heavy' as const],
    requiredCapabilities: ['freight-logistics'],
    requiredEnvironmentFactors: ['mountain'],
    riskTolerances: ['risk-tolerant' as const],
    requiredVerificationRequirements: ['carrier-insurance'],
    freshSurfaces: ['road-status'],
  };
}

/** Half-matches the spring context (season in, duration out): fit 0.5. */
function halfDeclared() {
  return {
    seasonWindows: ['spring'],
    durationClasses: ['long' as const],
  };
}

/** The §5 comparison set at a glance: one node of every kind. */
function comparisonSetComposition(bodyId: string) {
  return {
    nodes: [
      { nodeId: 'dispatch', kind: 'agent-body' as const, role: 'Dispatch lead', ref: bodyId, purposes: ['cognition' as const] },
      { nodeId: 'surge', kind: 'marketplace-agent-package' as const, role: 'Surge analyst', ref: 'pkg-surge-1', label: 'Surge analytics pack' },
      { nodeId: 'steward', kind: 'human-capability' as const, role: 'Fleet steward', ref: 'person-7', label: 'Maya' },
      { nodeId: 'auditor', kind: 'external-specialist' as const, role: 'Compliance auditor' },
      { nodeId: 'support', kind: 'tenant-agent' as const, role: 'Support triage' },
      { nodeId: 'routing', kind: 'marketplace-extension-package' as const, role: 'Routing extension', ref: 'ext-routing-2' },
    ],
    edges: [
      { fromNodeId: 'dispatch', toNodeId: 'surge', kind: 'delegation' as const, note: 'surge windows' },
      { fromNodeId: 'steward', toNodeId: 'dispatch', kind: 'review' as const, note: null },
      { fromNodeId: 'dispatch', toNodeId: 'support', kind: 'handoff' as const, note: null },
      { fromNodeId: 'support', toNodeId: 'steward', kind: 'escalation' as const, note: null },
      { fromNodeId: 'surge', toNodeId: 'dispatch', kind: 'information-feed' as const, note: null },
    ],
    informationRoutes: [{ registry: 'source' as const, ref: 'src-traffic', note: 'live traffic feed' }],
  };
}

/** A two-node dispatch crew (agent-body node with two occupancy purposes). */
function dispatchCrewComposition(bodyId: string) {
  return {
    nodes: [
      { nodeId: 'dispatch', kind: 'agent-body' as const, role: 'Dispatch lead', ref: bodyId, purposes: ['cognition' as const, 'analysis' as const] },
      { nodeId: 'steward', kind: 'human-capability' as const, role: 'Fleet steward', ref: 'person-9', label: 'Ada' },
    ],
    edges: [{ fromNodeId: 'steward', toNodeId: 'dispatch', kind: 'review' as const, note: null }],
    informationRoutes: [],
  };
}

/** A single-tenant-agent crew (no cross-module gates needed). */
function soloComposition() {
  return {
    nodes: [{ nodeId: 'solo', kind: 'tenant-agent' as const, role: 'Solo operator' }],
  };
}

const TRIAGE_AGENT: RegisterAgentInput = {
  slug: 'triage-analyst',
  displayName: 'Triage Analyst',
  role: 'conversation triage',
  description: 'Triages inbound conversations and drafts replies.',
  provider: 'openai-assistants',
  instructions: 'Triage the conversation and propose a reply.',
  permissions: ['observe', 'analyze', 'recommend'],
  runtimeConfig: { assistantId: 'asst_triage' },
};

function compatiblePolicy() {
  return {
    outcome: 'compatible' as const,
    basis: 'tenant provider policy v3: openai + anthropic allowed for this purpose',
    checkedBy: 'system:policy-engine',
    checkedAt: '2026-10-07T08:00:00.000Z',
  };
}

// ---------------------------------------------------------------------------
// Tenants (dedicated per concern so count/order assertions stay deterministic)
// ---------------------------------------------------------------------------

const tenantSearch = newId();
const tenantEvidence = newId();
const tenantErrors = newId();
const tenantIsoA = newId();
const tenantIsoB = newId();

// --- tenantSearch: THE CONTEXTUAL RULE + the twelve-axis search ---
let goalSearch: Goal;
let fpSpring: ContextFingerprint;
let fpWinter: ContextFingerprint;
let fpEmpty: ContextFingerprint;
let candSpring: Awaited<ReturnType<typeof registerCandidate>>;
let candWinter: Awaited<ReturnType<typeof registerCandidate>>;
let candGeneralist: Awaited<ReturnType<typeof registerCandidate>>;

// --- tenantEvidence: the §11 evidence chain (recommend → realize → calibrate)
let goalE: Goal;
let fpE: ContextFingerprint;
let strategyE: InfoStrategy;
let evalE: AgentEvaluation;
let agentE: AgentDefinition;
let candA: Awaited<ReturnType<typeof registerCandidate>>;
let candB: Awaited<ReturnType<typeof registerCandidate>>;
let candC: Awaited<ReturnType<typeof registerCandidate>>;
let outcomeExceeded: Outcome;
let outcomeMet: Outcome;
let outcomeMissed: Outcome;
let outcomeStillOpen: Outcome;
let rec1: Awaited<ReturnType<typeof recordRecommendation>>;
let rec2: Awaited<ReturnType<typeof recordRecommendation>>;
let rec3Id: string;
let measurementExceeded: Awaited<ReturnType<typeof recordMeasurement>>;
let measurementMissed: Awaited<ReturnType<typeof recordMeasurement>>;
let retiredB: Awaited<ReturnType<typeof retireCandidate>>;
let outcomeExceededSettled: Outcome;

// Fabric + body binding ids — REAL fabric-registered references (the
// WB3 composition wiring: a fresh agent-body attachment is existence-
// gated against the tenant's provider-fabric registry at the service
// boundary). These tests never parse the ids, only store and compare
// them verbatim (the W133/W132 seam ruling — opacity survives the gate).
// AB_COGNITION is the tenant's since-SUPERSEDED first cognition binding
// (existence, not activity — and it deliberately differs from the ACTIVE
// one, so the occupancy snapshot keeps proving the body attachment and
// the tenant binding are independent references); AB_ANALYSIS references
// the ACTIVE cognition binding from the body's analysis slot — the
// fabric's analysis purpose stays honestly unoccupied.
let AB_COGNITION: string;
let AB_ANALYSIS: string;
let fabricCognition: ModelBinding;
let fabricDefinition: ProviderDefinition;
let bodyE: AgentBody;

// --- tenantErrors: the typed error paths ---
let goalErr: Goal;
let goalErrOther: Goal;
let goalArchived: Goal;
let fpErr: ContextFingerprint;
let fpErrOther: ContextFingerprint;
let bodyRetired: AgentBody;
let outcomeSettledErr: Outcome;
let outcomeAbandonedErr: Outcome;
let outcomeErrOpen: Outcome;
let candErr1: Awaited<ReturnType<typeof registerCandidate>>;
let candErr2: Awaited<ReturnType<typeof registerCandidate>>;

// --- tenantIsoA / tenantIsoB: tenant isolation ---
let goalIsoA: Goal;
let goalIsoB: Goal;
let fpIsoA: ContextFingerprint;
let fpIsoB: ContextFingerprint;
let candIsoA1: Awaited<ReturnType<typeof registerCandidate>>;
let candIsoA2: Awaited<ReturnType<typeof registerCandidate>>;
let candIsoB1: Awaited<ReturnType<typeof registerCandidate>>;
let recIso: Awaited<ReturnType<typeof recordRecommendation>>;

/** Defines one OPEN learning outcome (the commitment BEFORE realization). */
async function openOutcome(
  ctx: TenantContext,
  metricName: string,
  metricUnit: string,
  direction: 'at_least' | 'at_most',
  baseline: number,
  expected: number,
): Promise<Outcome> {
  return defineOutcome(ctx, {
    subject: { kind: 'recommendation', id: newId(), label: 'w135 probe recommendation' },
    metricName,
    metricUnit,
    direction,
    baseline,
    expected,
    horizon: null,
    affectedGoals: [],
    originExecutionId: null,
    actor: { kind: 'person', label: 'ops lead' },
    rationale: 'the w135 commitment',
  });
}

/** Measures + settles an outcome at `value` (realization is evidence-grounded). */
async function settleAt(ctx: TenantContext, outcome: Outcome, value: number): Promise<void> {
  const measurement = await recordMeasurement(ctx, {
    outcomeId: outcome.id,
    value,
    actor: { kind: 'system', label: 'metrics-warehouse' },
  });
  await settleOutcome(ctx, {
    outcomeId: outcome.id,
    measurementId: measurement.id,
    actor: { kind: 'person', label: 'ops lead' },
  });
}

beforeAll(async () => {
  await runMigrations(getDb());

  // ------------------------------------------------------------------
  // tenantSearch — THE CONTEXTUAL RULE fixtures.
  // ------------------------------------------------------------------
  const searcher = member(tenantSearch);
  goalSearch = await createGoal(searcher, goalInput('City ride dispatch, spring window'));
  const bodySearch = await createAgentBody(searcher, {
    role: 'dispatch-body',
    label: 'Dispatch body',
  });
  candSpring = await registerCandidate(searcher, {
    slug: 'a-spring-crew',
    label: 'Spring sprint crew',
    description: 'The §5 comparison set in one composition.',
    composition: comparisonSetComposition(bodySearch.id),
    applicability: springDeclared(),
  });
  candWinter = await registerCandidate(searcher, {
    slug: 'b-winter-brigade',
    label: 'Winter freight brigade',
    composition: soloComposition(),
    applicability: winterDeclared(),
  });
  candGeneralist = await registerCandidate(searcher, {
    slug: 'c-generalist',
    label: 'Context-agnostic generalist',
    composition: soloComposition(),
  });
  fpSpring = await deriveFingerprint(searcher, {
    goalId: goalSearch.id,
    task: { title: 'ride dispatch', kind: 'operations' },
    observations: springObservations(),
    derivedFrom: ['obs-spring-1'],
  });
  fpWinter = await deriveFingerprint(searcher, {
    goalId: goalSearch.id,
    observations: winterObservations(),
    derivedFrom: ['obs-winter-1'],
  });
  fpEmpty = await deriveFingerprint(searcher, { goalId: goalSearch.id });

  // ------------------------------------------------------------------
  // tenantEvidence — the §11 evidence chain.
  // ------------------------------------------------------------------
  // The 'agents:administer' claim: registering the fixture agent (whose
  // measured evaluation rec1 later cites) goes through the agents
  // contract's own claim gate — the Lab itself has no authority gates.
  const owner = member(tenantEvidence, newId(), ['agents:administer']);
  goalE = await createGoal(owner, goalInput('Hold the 15-minute pickup SLA'));
  fpE = await deriveFingerprint(owner, {
    goalId: goalE.id,
    observations: springObservations(),
    derivedFrom: ['obs-evidence-1'],
  });

  // The W132 provider-fabric seam: known provider + manual catalog entry +
  // TWO tenant cognition bindings (the second supersedes the first). The
  // WB3 composition wiring requires the body's attachments below to
  // reference REAL fabric-registered bindings; the superseded first
  // binding is deliberate (existence, not activity) and keeps
  // bodyBindingId ≠ fabricBindingId — the two sides stay independent
  // references. Only cognition is bound at the tenant level; analysis
  // stays honestly unoccupied at the fabric level.
  fabricDefinition = await connectKnownProvider(owner, { provider: 'openai' });
  await registerModelManually(owner, {
    definitionId: fabricDefinition.definitionId,
    modelId: 'gpt-4o-mini',
    displayName: 'GPT-4o mini',
  });
  const fabricCognitionSuperseded = (
    await attachFabricBinding(owner, {
      purpose: 'cognition',
      definitionId: fabricDefinition.definitionId,
      modelId: 'gpt-4o-mini',
      accountId: newId(), // opaque W034 BYOA account reference
    })
  ).binding;
  fabricCognition = (
    await attachFabricBinding(owner, {
      purpose: 'cognition',
      definitionId: fabricDefinition.definitionId,
      modelId: 'gpt-4o-mini',
      accountId: newId(),
    })
  ).binding;
  AB_COGNITION = fabricCognitionSuperseded.bindingId;
  AB_ANALYSIS = fabricCognition.bindingId;

  // The W133 agent-body seam: one body, active attachments for two purposes.
  bodyE = await createAgentBody(owner, { role: 'dispatch-body', label: 'Dispatch body' });
  await attachBodyBinding(owner, {
    bodyId: bodyE.id,
    bindingId: AB_COGNITION,
    purpose: 'cognition',
    policyCheck: compatiblePolicy(),
  });
  await attachBodyBinding(owner, {
    bodyId: bodyE.id,
    bindingId: AB_ANALYSIS,
    purpose: 'analysis',
    policyCheck: compatiblePolicy(),
  });

  // The W024 agent-evaluation seam: a real measured evaluation to cite.
  agentE = (await registerAgent(owner, TRIAGE_AGENT)).agent;
  evalE = await recordAgentEvaluation(owner, {
    agentId: agentE.id,
    replacementOptions: [{ kind: 'retain', summary: 'Keep the triage agent as is.' }],
  });

  // The W134 info-strategy seam: a real strategy conditioned on goalE + fpE.
  const unknownE = await recordUnknown(owner, {
    question: 'Which dispatch composition holds the spring pickup SLA?',
    consequence: 'Not knowing this blocks the spring staffing decision.',
  });
  strategyE = await defineStrategy(owner, {
    goalId: goalE.id,
    fingerprintId: fpE.fingerprintId,
    content: {
      knowledgeRequirements: [
        {
          unknownId: unknownE.id,
          targetConfidence: 0.8,
          rationale: 'The spring window decision depends on it.',
        },
      ],
    },
    note: 'spring window strategy',
  });

  // The candidates: A (spring crew, agent-body occupancy), B (winter
  // alternative — the rejected one), C (half-fitting lean crew).
  candA = await registerCandidate(owner, {
    slug: 'a-dispatch-crew',
    label: 'Dispatch crew',
    composition: dispatchCrewComposition(bodyE.id),
    applicability: springDeclared(),
  });
  candB = await registerCandidate(owner, {
    slug: 'b-winter-brigade',
    label: 'Winter freight brigade',
    composition: soloComposition(),
    applicability: winterDeclared(),
  });
  candC = await registerCandidate(owner, {
    slug: 'c-lean-crew',
    label: 'Lean crew',
    composition: soloComposition(),
    applicability: halfDeclared(),
  });

  // The learning outcomes — OPEN at record time (prediction hygiene).
  outcomeExceeded = await openOutcome(owner, 'rides completed per week', 'rides', 'at_least', 1200, 1500);
  outcomeMet = await openOutcome(owner, 'median pickup minutes', 'minutes', 'at_most', 14, 10);
  outcomeMissed = await openOutcome(owner, 'rider rating', 'stars', 'at_least', 4.5, 4.8);
  outcomeStillOpen = await openOutcome(owner, 'escalation rate', 'percent', 'at_most', 8, 5);

  // rec1: the commitment BEFORE realization (with the strategy link and a
  // real cited agent evaluation).
  const restoreRec1 = pinClock(T_REC1);
  try {
    rec1 = await recordRecommendation(owner, {
    goalId: goalE.id,
    fingerprintId: fpE.fingerprintId,
    strategyId: strategyE.id,
    knowledgeObjective: 'A dispatch organization that holds a 15m pickup SLA in the spring window',
    evaluationConfig: {
      criteria: [
        { name: 'contextual fit', weight: 0.6 },
        { name: 'cost', weight: 0.4 },
      ],
      note: 'spring window evaluation',
    },
    candidates: [
      {
        candidateId: candA.id,
        disposition: 'recommended',
        summary: 'Fits the observed spring/short/light context on every declared axis.',
        scores: [
          { name: 'contextual fit', value: 0.95 },
          { name: 'cost', value: 0.7 },
        ],
        evidenceRefs: ['search-2026-10-07'],
        agentEvaluationIds: [evalE.id],
      },
      {
        candidateId: candB.id,
        disposition: 'rejected',
        rejectionReasons: ['declared for winter freight, not spring rides'],
        summary: 'Material context misfit.',
        agentEvaluationIds: [evalE.id],
      },
    ],
    expectedOutcomeIds: [outcomeExceeded.id, outcomeMet.id],
    derivedFrom: ['search-2026-10-07'],
    note: 'recorded after the contextual search',
    });
  } finally {
    restoreRec1();
  }

  // The realization: 1620 > 1500 (exceeded) and 10 == 10 (met) — both on
  // the improving side, so rec1's polarity must come out positive. The
  // CALIBRATION itself happens inside the recordCalibration describe, so
  // the recorded state stays observable first.
  measurementExceeded = await recordMeasurement(owner, {
    outcomeId: outcomeExceeded.id,
    value: 1620,
    actor: { kind: 'system', label: 'metrics-warehouse' },
  });
  await settleOutcome(owner, {
    outcomeId: outcomeExceeded.id,
    measurementId: measurementExceeded.id,
    actor: { kind: 'person', label: 'ops lead' },
  }).then((settled) => {
    outcomeExceededSettled = settled;
  });
  await settleAt(owner, outcomeMet, 10);

  // Retire the REJECTED alternative — its evaluation must survive this.
  const restoreRetire = pinClock(T_RETIRE_B);
  try {
    retiredB = await retireCandidate(owner, {
      candidateId: candB.id,
      reason: 'superseded by the spring crew after calibration',
    });
  } finally {
    restoreRetire();
  }

  // rec2: recommends the half-fitting lean crew whose outcome MISSES — the
  // negative-evidence arm. It also cites the now-RETIRED candidate B as a
  // rejected alternative (an evaluation of a retired design is legitimate
  // retained evidence; only the SEARCH refuses retired candidates).
  const restoreRec2 = pinClock(T_REC2);
  try {
    rec2 = await recordRecommendation(owner, {
    goalId: goalE.id,
    fingerprintId: fpE.fingerprintId,
    knowledgeObjective: 'A lean crew for the same spring window',
    evaluationConfig: { criteria: [{ name: 'contextual fit' }] },
    candidates: [
      {
        candidateId: candC.id,
        disposition: 'recommended',
        summary: 'Half-fits the observed context (season in, duration out).',
      },
      {
        candidateId: candB.id,
        disposition: 'rejected',
        rejectionReasons: ['retired design — retained as negative evidence'],
        summary: 'Evaluated although retired: the evaluation history is retained evidence.',
      },
    ],
    expectedOutcomeIds: [outcomeMissed.id],
    });
  } finally {
    restoreRec2();
  }
  measurementMissed = await recordMeasurement(owner, {
    outcomeId: outcomeMissed.id,
    value: 4.6, // 4.6 < 4.8 under 'at_least' — missed
    actor: { kind: 'system', label: 'metrics-warehouse' },
  });
  await settleOutcome(owner, {
    outcomeId: outcomeMissed.id,
    measurementId: measurementMissed.id,
    actor: { kind: 'person', label: 'ops lead' },
  });
  // rec2's calibration happens inside the recordCalibration describe.

  // ------------------------------------------------------------------
  // tenantErrors — the typed error paths.
  // ------------------------------------------------------------------
  const errer = member(tenantErrors);
  goalErr = await createGoal(errer, goalInput('Error-path goal'));
  goalErrOther = await createGoal(errer, goalInput('The OTHER goal'));
  goalArchived = await createGoal(errer, goalInput('A goal that gets archived'));
  await reviseGoal(errer, {
    goalId: goalArchived.id,
    status: 'archived',
    actor: { kind: 'system', label: 'w135-test' },
  });
  fpErr = await deriveFingerprint(errer, {
    goalId: goalErr.id,
    observations: springObservations(),
  });
  fpErrOther = await deriveFingerprint(errer, {
    goalId: goalErrOther.id,
    observations: winterObservations(),
  });
  bodyRetired = await createAgentBody(errer, { role: 'retired-probe-body', label: 'Retired probe' });
  await retireAgentBody(errer, { bodyId: bodyRetired.id });
  outcomeSettledErr = await openOutcome(errer, 'settled probe', 'units', 'at_least', 1, 2);
  await settleAt(errer, outcomeSettledErr, 2);
  outcomeAbandonedErr = await openOutcome(errer, 'abandoned probe', 'units', 'at_least', 1, 2);
  await abandonOutcome(errer, {
    outcomeId: outcomeAbandonedErr.id,
    reason: 'the probe was wound down',
    actor: { kind: 'person', label: 'ops lead' },
  });
  outcomeErrOpen = await openOutcome(errer, 'open probe', 'units', 'at_least', 1, 2);
  candErr1 = await registerCandidate(errer, {
    slug: 'err-crew-one',
    label: 'Error-path crew one',
    composition: soloComposition(),
  });
  candErr2 = await registerCandidate(errer, {
    slug: 'err-crew-two',
    label: 'Error-path crew two',
    composition: soloComposition(),
  });

  // ------------------------------------------------------------------
  // tenantIsoA / tenantIsoB — tenant isolation.
  // ------------------------------------------------------------------
  const isoA = member(tenantIsoA);
  const isoB = member(tenantIsoB);
  goalIsoA = await createGoal(isoA, goalInput('Isolation goal A'));
  goalIsoB = await createGoal(isoB, goalInput('Isolation goal B'));
  fpIsoA = await deriveFingerprint(isoA, {
    goalId: goalIsoA.id,
    observations: springObservations(),
  });
  fpIsoB = await deriveFingerprint(isoB, {
    goalId: goalIsoB.id,
    observations: winterObservations(),
  });
  candIsoA1 = await registerCandidate(isoA, {
    slug: 'solo-crew',
    label: 'Tenant A solo crew',
    composition: soloComposition(),
    applicability: springDeclared(),
  });
  candIsoA2 = await registerCandidate(isoA, {
    slug: 'backup-crew',
    label: 'Tenant A backup crew',
    composition: soloComposition(),
  });
  // The SAME slug lives independently in tenant B (slug uniqueness is
  // tenant-scoped).
  candIsoB1 = await registerCandidate(isoB, {
    slug: 'solo-crew',
    label: 'Tenant B solo crew',
    composition: soloComposition(),
    applicability: winterDeclared(),
  });
  const outcomeIso = await openOutcome(isoA, 'isolation probe', 'units', 'at_least', 0, 1);
  recIso = await recordRecommendation(isoA, {
    goalId: goalIsoA.id,
    fingerprintId: fpIsoA.fingerprintId,
    knowledgeObjective: 'An isolation-bound recommendation',
    evaluationConfig: { criteria: [{ name: 'fit' }] },
    candidates: [
      {
        candidateId: candIsoA1.id,
        disposition: 'recommended',
        summary: 'The only active candidate.',
      },
      {
        candidateId: candIsoA2.id,
        disposition: 'rejected',
        rejectionReasons: ['declares nothing — no contextual signal'],
        summary: 'The agnostic backup.',
      },
    ],
    expectedOutcomeIds: [outcomeIso.id],
  });
});

afterAll(async () => {
  await closeDb();
});

// ---------------------------------------------------------------------------
// The candidate registry
// ---------------------------------------------------------------------------

describe('W135 registerCandidate / getCandidate / listCandidates', () => {
  it('round-trips the full §4 composition with the §5 comparison set and the declared hypotheses', async () => {
    const searcher = member(tenantSearch);
    const read = await getCandidate(searcher, { candidateId: candSpring.id });
    expect(read.id).toBe(candSpring.id);
    expect(read.tenantId).toBe(tenantSearch);
    expect(read.slug).toBe('a-spring-crew');
    expect(read.status).toBe('active');
    expect(read.retiredAt).toBeNull();
    expect(read.createdBy).toBe(candSpring.createdBy);
    expect(read.composition.nodes).toHaveLength(6);
    expect(read.composition.nodes[0]).toEqual({
      nodeId: 'dispatch',
      kind: 'agent-body',
      role: 'Dispatch lead',
      ref: expect.any(String),
      label: null,
      purposes: ['cognition'],
    });
    expect(read.composition.edges).toHaveLength(5);
    expect(read.composition.informationRoutes).toEqual([
      { registry: 'source', ref: 'src-traffic', note: 'live traffic feed' },
    ]);
    expect(read.applicability.seasonWindows).toEqual(['spring']);
    expect(read.applicability.riskTolerances).toEqual(['risk-averse']);
    expect(read.applicability.budgetNote).toBe('cost-conscious crew');
  });

  it('reads a foreign candidate id uniformly as candidate_not_found (no existence leak)', async () => {
    const searcher = member(tenantSearch);
    await expectCode('candidate_not_found', () =>
      getCandidate(searcher, { candidateId: newId() }),
    );
    await expectCode('candidate_not_found', () =>
      getCandidate(member(tenantEvidence), { candidateId: candSpring.id }),
    );
  });

  it('rejects a duplicate slug in the SAME tenant (candidate_slug_taken)', async () => {
    await expectCode('candidate_slug_taken', () =>
      registerCandidate(member(tenantSearch), {
        slug: 'a-spring-crew',
        label: 'Impostor crew',
        composition: soloComposition(),
      }),
    );
  });

  it('gates agent-body node refs through the W133 seam: foreign bodies and retired bodies are refused', async () => {
    const errer = member(tenantErrors);
    await expectCode('node_ref_not_found', () =>
      registerCandidate(errer, {
        slug: 'ghost-body-crew',
        label: 'Ghost body crew',
        composition: {
          nodes: [
            { nodeId: 'dispatch', kind: 'agent-body', role: 'Dispatch', ref: newId(), purposes: ['cognition'] },
          ],
        },
      }),
    );
    await expectCode('node_ref_inactive', () =>
      registerCandidate(errer, {
        slug: 'retired-body-crew',
        label: 'Retired body crew',
        composition: {
          nodes: [
            { nodeId: 'dispatch', kind: 'agent-body', role: 'Dispatch', ref: bodyRetired.id, purposes: ['cognition'] },
          ],
        },
      }),
    );
  });

  it('listCandidates takes a query object, orders by slug ASC and stays tenant-scoped', async () => {
    const searcher = member(tenantSearch);
    const active = await listCandidates(searcher, { status: 'active' });
    expect(active.map((candidate) => candidate.slug)).toEqual([
      'a-spring-crew',
      'b-winter-brigade',
      'c-generalist',
    ]);
    const limited = await listCandidates(searcher, { limit: 2 });
    expect(limited.map((candidate) => candidate.slug)).toEqual([
      'a-spring-crew',
      'b-winter-brigade',
    ]);
    const everything = await listCandidates(searcher);
    expect(everything).toHaveLength(3);
    // Tenant scoping: the errors tenant sees only its own two.
    const errerList = await listCandidates(member(tenantErrors));
    expect(errerList.map((candidate) => candidate.slug)).toEqual(['err-crew-one', 'err-crew-two']);
  });

  it('retireCandidate is one-way: stamps once, refuses a second retire, leaves content untouched', async () => {
    const owner = member(tenantEvidence);
    expect(retiredB.status).toBe('retired');
    expect(retiredB.retiredAt).toBe(T_RETIRE_B);
    expect(retiredB.lifecycleNote).toBe('superseded by the spring crew after calibration');
    expect(retiredB.slug).toBe('b-winter-brigade');
    expect(retiredB.applicability).toEqual(candB.applicability);
    // The one-way lifecycle.
    await expectCode('candidate_retired', () =>
      retireCandidate(owner, { candidateId: candB.id, reason: 'twice is once too many' }),
    );
    // Retired candidates are excluded from the ACTIVE list but retained.
    const active = await listCandidates(owner, { status: 'active' });
    expect(active.map((candidate) => candidate.slug)).toEqual(['a-dispatch-crew', 'c-lean-crew']);
    const retired = await listCandidates(owner, { status: 'retired' });
    expect(retired.map((candidate) => candidate.slug)).toEqual(['b-winter-brigade']);
  });

  it('enforces candidate-content immutability at the STORAGE level (a changed design is a NEW candidate)', async () => {
    await expect(
      getDb().query(
        `UPDATE org_candidates SET label = 'rewritten' WHERE tenant_id = $1 AND slug = 'a-dispatch-crew'`,
        [tenantEvidence],
      ),
    ).rejects.toThrowError(/immutable/);
    await expect(
      getDb().query(`DELETE FROM org_candidates WHERE tenant_id = $1`, [tenantEvidence]),
    ).rejects.toThrowError(/lifecycle-managed/);
    await expect(getDb().query(`TRUNCATE org_candidates`)).rejects.toThrowError(
      /lifecycle-managed/,
    );
  });
});

// ---------------------------------------------------------------------------
// searchOrganizations — the contextually-conditioned search
// ---------------------------------------------------------------------------

describe('W135 searchOrganizations (the twelve-axis contextual search)', () => {
  it('THE CONTEXTUAL RULE, END TO END: the same candidates under two materially different fingerprints rank a DIFFERENT candidate first', async () => {
    const searcher = member(tenantSearch);
    const underSpring = await searchOrganizations(searcher, {
      goalId: goalSearch.id,
      fingerprintId: fpSpring.fingerprintId,
    });
    expect(underSpring.map((result) => result.candidateId)).toEqual([
      candSpring.id,
      candGeneralist.id,
      candWinter.id,
    ]);
    expect(underSpring[0]!.slug).toBe('a-spring-crew');
    expect(underSpring[0]!.fitScore).toBe(1);
    expect(underSpring[0]!.rankScore).toBe(1);

    const underWinter = await searchOrganizations(searcher, {
      goalId: goalSearch.id,
      fingerprintId: fpWinter.fingerprintId,
    });
    expect(underWinter.map((result) => result.candidateId)).toEqual([
      candWinter.id,
      candGeneralist.id,
      candSpring.id,
    ]);
    expect(underWinter[0]!.slug).toBe('b-winter-brigade');
    expect(underWinter[0]!.fitScore).toBe(1);
    expect(underWinter[0]!.rankScore).toBe(1);
    // The divergence is data: the SAME candidate set, the SAME goal, only
    // the observed context differs.
    expect(underSpring[0]!.candidateId).not.toBe(underWinter[0]!.candidateId);
  });

  it('carries the twelve-axis fit report per result, in canonical order, with human-auditable declared/observed summaries', async () => {
    const searcher = member(tenantSearch);
    const results = await searchOrganizations(searcher, {
      goalId: goalSearch.id,
      fingerprintId: fpSpring.fingerprintId,
    });
    const spring = results[0]!;
    const winter = results[2]!;
    expect(spring.dimensions.map((entry) => entry.axis)).toEqual([
      'season', 'duration', 'staffing', 'workload', 'capabilities', 'environment',
      'budget', 'quality', 'risk', 'verification', 'evidence-freshness', 'sla',
    ]);
    const verdicts = new Map(spring.dimensions.map((entry) => [entry.axis, entry.verdict]));
    expect(verdicts.get('season')).toBe('match');
    expect(verdicts.get('duration')).toBe('match');
    expect(verdicts.get('staffing')).toBe('match');
    expect(verdicts.get('workload')).toBe('match');
    expect(verdicts.get('capabilities')).toBe('match');
    expect(verdicts.get('environment')).toBe('match');
    expect(verdicts.get('risk')).toBe('match');
    expect(verdicts.get('verification')).toBe('match');
    expect(verdicts.get('evidence-freshness')).toBe('match');
    // The free-text axes are advisory: both postures surfaced, never matched.
    expect(verdicts.get('budget')).toBe('advisory');
    expect(verdicts.get('quality')).toBe('advisory');
    expect(verdicts.get('sla')).toBe('advisory');
    const season = spring.dimensions.find((entry) => entry.axis === 'season')!;
    expect(season.declared).toContain('spring');
    expect(season.observed).toContain('spring');

    // The winter design under the spring fingerprint: every declared
    // mechanical axis misfits, fit 0.
    const winterVerdicts = new Map(winter.dimensions.map((entry) => [entry.axis, entry.verdict]));
    expect(winterVerdicts.get('season')).toBe('misfit');
    expect(winterVerdicts.get('duration')).toBe('misfit');
    expect(winterVerdicts.get('staffing')).toBe('misfit');
    expect(winterVerdicts.get('workload')).toBe('misfit');
    expect(winterVerdicts.get('capabilities')).toBe('misfit');
    expect(winterVerdicts.get('environment')).toBe('misfit');
    expect(winterVerdicts.get('risk')).toBe('misfit');
    expect(winterVerdicts.get('verification')).toBe('misfit');
    expect(winterVerdicts.get('evidence-freshness')).toBe('misfit');
    expect(winter.fitScore).toBe(0);
    expect(winter.rankScore).toBe(0);
  });

  it('treats an undeclaring candidate as agnostic with fitScore null (never a fabricated 0.5) and reports the node-kind census', async () => {
    const searcher = member(tenantSearch);
    const results = await searchOrganizations(searcher, {
      goalId: goalSearch.id,
      fingerprintId: fpSpring.fingerprintId,
    });
    const generalist = results[1]!;
    expect(generalist.slug).toBe('c-generalist');
    expect(generalist.fitScore).toBeNull();
    expect(generalist.rankScore).toBe(0.5); // the neutral blend baseline
    expect(generalist.calibration).toBeNull(); // the honest cold start
    for (const entry of generalist.dimensions) {
      if (entry.axis === 'budget' || entry.axis === 'quality' || entry.axis === 'sla') {
        expect(entry.verdict).toBe('advisory');
      } else {
        expect(entry.verdict).toBe('agnostic');
      }
    }
    // The §5 comparison set at a glance: one node of every kind.
    expect(results[0]!.nodeKinds).toEqual({
      'agent-body': 1,
      'tenant-agent': 1,
      'marketplace-agent-package': 1,
      'marketplace-extension-package': 1,
      'human-capability': 1,
      'external-specialist': 1,
    });
  });

  it('honors the null-signal law end to end: an empty-observation fingerprint reports every axis unobserved', async () => {
    const searcher = member(tenantSearch);
    const results = await searchOrganizations(searcher, {
      goalId: goalSearch.id,
      fingerprintId: fpEmpty.fingerprintId,
    });
    expect(results).toHaveLength(3);
    for (const result of results) {
      expect(result.fitScore).toBeNull();
      for (const entry of result.dimensions) {
        expect(entry.verdict).toBe('unobserved');
        expect(entry.observed).toBe('(not observed)');
      }
    }
    // All three are cold agnostics under the empty fingerprint — the slug
    // tie-break orders them.
    expect(results.map((result) => result.slug)).toEqual([
      'a-spring-crew',
      'b-winter-brigade',
      'c-generalist',
    ]);
  });

  it('applies the limit after ranking and refuses malformed queries', async () => {
    const searcher = member(tenantSearch);
    const top2 = await searchOrganizations(searcher, {
      goalId: goalSearch.id,
      fingerprintId: fpSpring.fingerprintId,
      limit: 2,
    });
    expect(top2.map((result) => result.slug)).toEqual(['a-spring-crew', 'c-generalist']);
    await expectCode('invalid_query', () =>
      searchOrganizations(searcher, { goalId: 'not-a-uuid', fingerprintId: fpSpring.fingerprintId }),
    );
    await expectCode('invalid_query', () =>
      searchOrganizations(searcher, { goalId: goalSearch.id, fingerprintId: fpSpring.fingerprintId, limit: 0 }),
    );
  });

  it('maps every foreign or incoherent reference to its typed code (goals, fingerprints, fingerprint/goal mismatch)', async () => {
    const errer = member(tenantErrors);
    await expectCode('goal_not_found', () =>
      searchOrganizations(errer, { goalId: newId(), fingerprintId: fpErr.fingerprintId }),
    );
    // An ARCHIVED goal is as unavailable as a missing one — the Lab serves
    // current direction only.
    await expectCode('goal_not_found', () =>
      searchOrganizations(errer, { goalId: goalArchived.id, fingerprintId: fpErr.fingerprintId }),
    );
    await expectCode('fingerprint_not_found', () =>
      searchOrganizations(errer, { goalId: goalErr.id, fingerprintId: newId() }),
    );
    // A readable fingerprint derived for a DIFFERENT goal is incoherent.
    await expectCode('fingerprint_goal_mismatch', () =>
      searchOrganizations(errer, { goalId: goalErr.id, fingerprintId: fpErrOther.fingerprintId }),
    );
  });
});

// ---------------------------------------------------------------------------
// recordRecommendation — the §11 evidence object
// ---------------------------------------------------------------------------

describe('W135 recordRecommendation (the §11 evidence object)', () => {
  it('round-trips the full evidence object: goal revision, fingerprint, strategy link, config, positions and provenance', async () => {
    const owner = member(tenantEvidence);
    const read = await getRecommendation(owner, { recommendationId: rec1.id });
    expect(read.id).toBe(rec1.id);
    expect(read.tenantId).toBe(tenantEvidence);
    expect(read.goalId).toBe(goalE.id);
    expect(read.goalVersion).toBe(1); // the §11 "goal revision" snapshot
    expect(read.fingerprintId).toBe(fpE.fingerprintId);
    expect(read.strategyId).toBe(strategyE.id); // the W134 link, verbatim
    expect(read.knowledgeObjective).toBe(
      'A dispatch organization that holds a 15m pickup SLA in the spring window',
    );
    expect(read.evaluationConfig.criteria).toEqual([
      { name: 'contextual fit', weight: 0.6 },
      { name: 'cost', weight: 0.4 },
    ]);
    expect(read.evaluationConfig.note).toBe('spring window evaluation');
    expect(read.recommendedCandidateId).toBe(candA.id);
    expect(read.status).toBe('recorded');
    expect(read.note).toBe('recorded after the contextual search');
    expect(read.derivedFrom).toEqual(['search-2026-10-07']);
    expect(read.recordedBy).toBe(rec1.recordedBy);
    expect(read.calibratedAt).toBeNull();
    expect(read.calibration).toBeNull();
  });

  it('RETAINS THE REJECTED CANDIDATE (the acceptance law): every evaluated candidate survives with its rejection reasons', async () => {
    const owner = member(tenantEvidence);
    const read = await getRecommendation(owner, { recommendationId: rec1.id });
    expect(read.candidates).toHaveLength(2);
    const [winner, rejected] = read.candidates;
    expect(winner!.candidateId).toBe(candA.id);
    expect(winner!.disposition).toBe('recommended');
    expect(winner!.rejectionReasons).toEqual([]);
    expect(winner!.position).toBe(1);
    expect(winner!.scores).toEqual([
      { name: 'contextual fit', value: 0.95 },
      { name: 'cost', value: 0.7 },
    ]);
    expect(winner!.evidenceRefs).toEqual(['search-2026-10-07']);
    expect(winner!.agentEvaluationIds).toEqual([evalE.id]); // the cited W024 measurement
    expect(rejected!.candidateId).toBe(candB.id);
    expect(rejected!.disposition).toBe('rejected');
    expect(rejected!.rejectionReasons).toEqual(['declared for winter freight, not spring rides']);
    expect(rejected!.position).toBe(2);

    // The retention survives the candidate's own RETIREMENT (retired in
    // beforeAll, between rec1 and rec2): the evaluation history is
    // retained evidence about designs that were considered.
    const afterRetire = await getRecommendation(owner, { recommendationId: rec1.id });
    expect(afterRetire.candidates.map((entry) => entry.candidateId)).toContain(candB.id);
    // And rec2's evaluation of the RETIRED candidate is legitimate too.
    const read2 = await getRecommendation(owner, { recommendationId: rec2.id });
    const retiredEvaluation = read2.candidates.find((entry) => entry.candidateId === candB.id)!;
    expect(retiredEvaluation.disposition).toBe('rejected');
    expect(retiredEvaluation.rejectionReasons).toEqual([
      'retired design — retained as negative evidence',
    ]);
  });

  it('snapshots the model occupancy through the W133 + W132 seams (opaque binding ids VERBATIM, null = honestly unoccupied)', async () => {
    const owner = member(tenantEvidence);
    const read = await getRecommendation(owner, { recommendationId: rec1.id });
    expect(read.modelOccupancy).toHaveLength(2); // (dispatch, analysis) then (dispatch, cognition)
    expect(read.modelOccupancy.map((row) => [row.nodeId, row.purpose])).toEqual([
      ['dispatch', 'analysis'],
      ['dispatch', 'cognition'],
    ]);
    const cognition = read.modelOccupancy.find((row) => row.purpose === 'cognition')!;
    expect(cognition.bodyId).toBe(bodyE.id);
    expect(cognition.role).toBe('Dispatch lead');
    expect(cognition.bodyBindingId).toBe(AB_COGNITION); // the body's active attachment, verbatim
    expect(cognition.fabricBindingId).toBe(fabricCognition.bindingId); // the tenant's active fabric binding, verbatim
    const analysis = read.modelOccupancy.find((row) => row.purpose === 'analysis')!;
    expect(analysis.bodyBindingId).toBe(AB_ANALYSIS);
    expect(analysis.fabricBindingId).toBeNull(); // no tenant-level analysis binding — honest
  });

  it('commits to the OPEN learning outcomes BEFORE realization (immutable definition snapshots)', async () => {
    const owner = member(tenantEvidence);
    const read = await getRecommendation(owner, { recommendationId: rec1.id });
    // Stored in the deterministic outcome_id ASC order.
    expect([...read.expectedOutcomes].sort((a, b) => (a.outcomeId < b.outcomeId ? -1 : 1))).toEqual(
      [
        {
          outcomeId: outcomeExceeded.id,
          metricName: 'rides completed per week',
          metricUnit: 'rides',
          direction: 'at_least',
          baseline: 1200,
          expected: 1500,
        },
        {
          outcomeId: outcomeMet.id,
          metricName: 'median pickup minutes',
          metricUnit: 'minutes',
          direction: 'at_most',
          baseline: 14,
          expected: 10,
        },
      ].sort((a, b) => (a.outcomeId < b.outcomeId ? -1 : 1)),
    );
  });

  it('enforces the append-only evidence law at the STORAGE level (retained candidates can never be rewritten or dropped)', async () => {
    await expect(
      getDb().query(
        `UPDATE org_recommendation_candidates SET disposition = 'recommended'
           WHERE tenant_id = $1 AND recommendation_id = $2`,
        [tenantEvidence, rec1.id],
      ),
    ).rejects.toThrowError(/append-only/);
    await expect(
      getDb().query(
        `DELETE FROM org_recommendation_candidates WHERE tenant_id = $1 AND recommendation_id = $2`,
        [tenantEvidence, rec1.id],
      ),
    ).rejects.toThrowError(/append-only/);
    await expect(getDb().query(`TRUNCATE org_recommendation_candidates`)).rejects.toThrowError(
      /append-only/,
    );
    await expect(getDb().query(`TRUNCATE org_recommendations`)).rejects.toThrowError(
      /lifecycle-managed/,
    );
    // The occupancy and outcome snapshots are equally immutable.
    await expect(
      getDb().query(
        `UPDATE org_recommendation_outcomes SET expected = 999
           WHERE tenant_id = $1 AND recommendation_id = $2`,
        [tenantEvidence, rec1.id],
      ),
    ).rejects.toThrowError(/append-only/);
    await expect(
      getDb().query(
        `DELETE FROM org_recommendation_occupancy WHERE tenant_id = $1 AND recommendation_id = $2`,
        [tenantEvidence, rec1.id],
      ),
    ).rejects.toThrowError(/append-only/);
  });

  it('maps every foreign evidence reference to its typed code (candidates, strategies, agent evaluations, outcomes)', async () => {
    const errer = member(tenantErrors);
    const base = {
      goalId: goalErr.id,
      fingerprintId: fpErr.fingerprintId,
      knowledgeObjective: 'error-path objective',
      evaluationConfig: { criteria: [{ name: 'fit' }] },
      expectedOutcomeIds: [] as string[],
    };
    // A foreign evaluated candidate.
    await expectCode('candidate_not_found', () =>
      recordRecommendation(errer, {
        ...base,
        candidates: [
          { candidateId: newId(), disposition: 'rejected', rejectionReasons: ['ghost'], summary: 'Ghost.' },
          { candidateId: candErr2.id, disposition: 'rejected', rejectionReasons: ['real'], summary: 'Real.' },
        ],
        expectedOutcomeIds: [outcomeErrOpen.id],
      }),
    );
    // A foreign strategy link.
    await expectCode('strategy_not_found', () =>
      recordRecommendation(errer, {
        ...base,
        strategyId: newId(),
        candidates: [
          { candidateId: candErr1.id, disposition: 'recommended', summary: 'Winner.' },
          { candidateId: candErr2.id, disposition: 'rejected', rejectionReasons: ['why'], summary: 'Loser.' },
        ],
        expectedOutcomeIds: [outcomeErrOpen.id],
      }),
    );
    // A foreign agent evaluation.
    await expectCode('evaluation_ref_not_found', () =>
      recordRecommendation(errer, {
        ...base,
        candidates: [
          {
            candidateId: candErr1.id,
            disposition: 'recommended',
            summary: 'Winner.',
            agentEvaluationIds: [newId()],
          },
          { candidateId: candErr2.id, disposition: 'rejected', rejectionReasons: ['why'], summary: 'Loser.' },
        ],
        expectedOutcomeIds: [outcomeStillOpen.id],
      }),
    );
    // A SETTLED outcome can never be committed to (realization already
    // happened — prediction hygiene), and neither can an ABANDONED one.
    await expectCode('invalid_outcome_ref', () =>
      recordRecommendation(errer, {
        ...base,
        candidates: [
          { candidateId: candErr1.id, disposition: 'recommended', summary: 'Winner.' },
          { candidateId: candErr2.id, disposition: 'rejected', rejectionReasons: ['why'], summary: 'Loser.' },
        ],
        expectedOutcomeIds: [outcomeSettledErr.id],
      }),
    );
    await expectCode('invalid_outcome_ref', () =>
      recordRecommendation(errer, {
        ...base,
        candidates: [
          { candidateId: candErr1.id, disposition: 'recommended', summary: 'Winner.' },
          { candidateId: candErr2.id, disposition: 'rejected', rejectionReasons: ['why'], summary: 'Loser.' },
        ],
        expectedOutcomeIds: [outcomeAbandonedErr.id],
      }),
    );
    // A foreign outcome id is indistinguishable from those.
    await expectCode('invalid_outcome_ref', () =>
      recordRecommendation(errer, {
        ...base,
        candidates: [
          { candidateId: candErr1.id, disposition: 'recommended', summary: 'Winner.' },
          { candidateId: candErr2.id, disposition: 'rejected', rejectionReasons: ['why'], summary: 'Loser.' },
        ],
        expectedOutcomeIds: [newId()],
      }),
    );
  });

  it('accepts the honest no-winner case: zero recommended candidates, no occupancy snapshot', async () => {
    const errer = member(tenantErrors);
    const noWinner = await recordRecommendation(errer, {
      goalId: goalErr.id,
      fingerprintId: fpErr.fingerprintId,
      knowledgeObjective: 'A probe with no clear winner',
      evaluationConfig: { criteria: [{ name: 'fit' }] },
      candidates: [
        {
          candidateId: candErr1.id,
          disposition: 'rejected',
          rejectionReasons: ['no contextual signal under this fingerprint'],
          summary: 'Declares nothing.',
        },
        {
          candidateId: candErr2.id,
          disposition: 'rejected',
          rejectionReasons: ['also nothing declared'],
          summary: 'Also declares nothing.',
        },
      ],
      expectedOutcomeIds: [outcomeErrOpen.id],
    });
    expect(noWinner.recommendedCandidateId).toBeNull();
    expect(noWinner.modelOccupancy).toEqual([]);
    expect(noWinner.candidates.every((entry) => entry.disposition === 'rejected')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// recordCalibration — the outcome-calibration loop
// ---------------------------------------------------------------------------

describe('W135 recordCalibration (the outcome-calibration loop)', () => {
  it('refuses to calibrate while an expected outcome is still OPEN, and an ABANDONED outcome never realizes', async () => {
    const owner = member(tenantEvidence);
    // rec3: commits to outcomeStillOpen — never settles.
    const restoreRec3 = pinClock(T_REC3);
    let rec3: Awaited<ReturnType<typeof recordRecommendation>>;
    try {
      rec3 = await recordRecommendation(owner, {
        goalId: goalE.id,
        fingerprintId: fpE.fingerprintId,
        knowledgeObjective: 'A probe recommendation whose outcome never realizes',
        evaluationConfig: { criteria: [{ name: 'probe' }] },
        candidates: [
          { candidateId: candA.id, disposition: 'recommended', summary: 'Probe winner.' },
          { candidateId: candC.id, disposition: 'rejected', rejectionReasons: ['probe alternative'], summary: 'Probe alternative.' },
        ],
        expectedOutcomeIds: [outcomeStillOpen.id],
      });
    } finally {
      restoreRec3();
    }
    rec3Id = rec3.id;
    // Still OPEN: refused, and the recommendation stays 'recorded'.
    await expectCode('invalid_outcome_ref', () =>
      recordCalibration(owner, { recommendationId: rec3.id }),
    );
    expect((await getRecommendation(owner, { recommendationId: rec3.id })).status).toBe('recorded');
    // The outcome gets abandoned — an abandoned outcome never realizes, so
    // the recommendation can never calibrate (retained uncalibrated
    // evidence, honestly).
    await abandonOutcome(owner, {
      outcomeId: outcomeStillOpen.id,
      reason: 'the probe was wound down',
      actor: { kind: 'person', label: 'ops lead' },
    });
    await expectCode('invalid_outcome_ref', () =>
      recordCalibration(owner, { recommendationId: rec3.id }),
    );
    expect((await getRecommendation(owner, { recommendationId: rec3.id })).status).toBe('recorded');
  });

  it('calibrates the positive arm: consumes the FROZEN realizations, stamps the one-way transition exactly once', async () => {
    const owner = member(tenantEvidence);
    // The recorded state was observable in the recordRecommendation
    // describe; the outcomes settled in beforeAll — calibrate NOW (clock
    // pinned so the stamp is deterministic).
    const calibrator = member(tenantEvidence);
    const restoreCal1 = pinClock(T_CALIBRATE_1);
    try {
      await recordCalibration(calibrator, { recommendationId: rec1.id, note: 'both outcomes landed' });
    } finally {
      restoreCal1();
    }
    const calibrated = await getRecommendation(owner, { recommendationId: rec1.id });
    expect(calibrated.status).toBe('calibrated');
    expect(calibrated.calibratedAt).toBe(T_CALIBRATE_1);
    expect(calibrated.calibration).not.toBeNull();
    expect(calibrated.calibration!.polarity).toBe('positive'); // exceeded + met
    expect(calibrated.calibration!.note).toBe('both outcomes landed');
    // System-captured from the explicit TenantContext, never caller-supplied.
    expect(calibrated.calibration!.calibratedBy).toBe(calibrator.principalId);
    // The frozen realizations: learning's verdicts consumed VERBATIM.
    expect(calibrated.calibration!.realized).toHaveLength(2);
    const exceeded = calibrated.calibration!.realized.find(
      (entry) => entry.outcomeId === outcomeExceeded.id,
    )!;
    expect(exceeded.realizedValue).toBe(1620);
    expect(exceeded.varianceVsExpected).toBe(120);
    expect(exceeded.assessment).toBe('exceeded');
    expect(exceeded.fromMeasurementId).toBe(measurementExceeded.id);
    expect(exceeded.settledAt).toBe(outcomeExceededSettled.realization!.settledAt);
    const met = calibrated.calibration!.realized.find(
      (entry) => entry.outcomeId === outcomeMet.id,
    )!;
    expect(met.assessment).toBe('met');
    // Terminal: one calibration per recommendation, ever.
    await expectCode('recommendation_already_calibrated', () =>
      recordCalibration(owner, { recommendationId: rec1.id, note: 'twice' }),
    );
    // And the calibration row itself is append-only at the storage level.
    await expect(
      getDb().query(
        `UPDATE org_recommendation_calibrations SET polarity = 'negative'
           WHERE tenant_id = $1 AND recommendation_id = $2`,
        [tenantEvidence, rec1.id],
      ),
    ).rejects.toThrowError(/append-only/);
    await expect(
      getDb().query(
        `DELETE FROM org_recommendation_calibrations WHERE tenant_id = $1 AND recommendation_id = $2`,
        [tenantEvidence, rec1.id],
      ),
    ).rejects.toThrowError(/append-only/);
  });

  it('retains FAILED recommendations as negative evidence (a single missed outcome makes the polarity negative)', async () => {
    const owner = member(tenantEvidence);
    const restoreCal2 = pinClock(T_CALIBRATE_2);
    try {
      await recordCalibration(owner, { recommendationId: rec2.id, note: 'the rating slipped' });
    } finally {
      restoreCal2();
    }
    const calibrated = await getRecommendation(owner, { recommendationId: rec2.id });
    expect(calibrated.status).toBe('calibrated');
    expect(calibrated.calibration!.polarity).toBe('negative'); // 4.6 < 4.8 missed
    expect(calibrated.calibration!.realized).toHaveLength(1);
    expect(calibrated.calibration!.realized[0]!.assessment).toBe('missed');
    expect(calibrated.calibration!.realized[0]!.fromMeasurementId).toBe(measurementMissed.id);
    expect(calibrated.calibration!.note).toBe('the rating slipped');
    expect(calibrated.calibratedAt).toBe(T_CALIBRATE_2);
    // The failed recommendation's evidence is fully retained.
    expect(calibrated.candidates.map((entry) => entry.candidateId)).toEqual([candC.id, candB.id]);
  });

  it('reads foreign recommendations uniformly as recommendation_not_found', async () => {
    const owner = member(tenantEvidence);
    await expectCode('recommendation_not_found', () =>
      getRecommendation(owner, { recommendationId: newId() }),
    );
    await expectCode('recommendation_not_found', () =>
      recordCalibration(owner, { recommendationId: newId() }),
    );
    // Cross-tenant: tenant B cannot even see tenant A's recommendation.
    await expectCode('recommendation_not_found', () =>
      getRecommendation(member(tenantIsoB), { recommendationId: recIso.id }),
    );
  });
});

// ---------------------------------------------------------------------------
// The calibration loop feeding back into the search
// ---------------------------------------------------------------------------

describe('W135 the calibrated evidence modulates the search (outcome-calibrated recommendations)', () => {
  it('carries the calibration aggregate on search results and lets positive evidence lift a candidate above its raw fit', async () => {
    const owner = member(tenantEvidence);
    const results = await searchOrganizations(owner, {
      goalId: goalE.id,
      fingerprintId: fpE.fingerprintId,
    });
    // candB is retired — the search refuses retired candidates.
    expect(results.map((result) => result.slug)).toEqual(['a-dispatch-crew', 'c-lean-crew']);
    const a = results.find((result) => result.candidateId === candA.id)!;
    const c = results.find((result) => result.candidateId === candC.id)!;

    // A: fit 1.0 with 1/1 positive samples — smoothed (1+1)/(1+2) = 2/3,
    // factor 1 + 0.5 * (2/3 - 1/2) = 1.0833... EVIDENCE OVERTAKES FIT:
    // the rank score now exceeds the raw contextual fit.
    expect(a.fitScore).toBe(1);
    expect(a.rankScore).toBeCloseTo(1 * (1 + 0.5 * (2 / 3 - 0.5)), 10);
    expect(a.rankScore).toBeGreaterThan(a.fitScore!);
    expect(a.calibration).toEqual({
      candidateId: candA.id,
      sampleSize: 1,
      successes: 1,
      failures: 0,
      successRate: 1,
      evidenceRecommendationIds: [rec1.id],
    });

    // C: fit 0.5 with 1/1 NEGATIVE samples — smoothed 1/3, factor
    // 1 + 0.5 * (1/3 - 1/2) = 0.9166... FAILURE IS RETAINED AND IT COSTS:
    // the negative evidence drags the rank score below the raw fit.
    expect(c.fitScore).toBeCloseTo(0.5, 10);
    expect(c.rankScore).toBeCloseTo(0.5 * (1 + 0.5 * (1 / 3 - 0.5)), 10);
    expect(c.rankScore).toBeLessThan(c.fitScore!);
    expect(c.calibration).toEqual({
      candidateId: candC.id,
      sampleSize: 1,
      successes: 0,
      failures: 1,
      successRate: 0,
      evidenceRecommendationIds: [rec2.id],
    });
  });

  it('getCandidateCalibration reports the aggregate, the honest cold start and the uniform not-found', async () => {
    const owner = member(tenantEvidence);
    const a = await getCandidateCalibration(owner, { candidateId: candA.id });
    expect(a).toEqual({
      candidateId: candA.id,
      sampleSize: 1,
      successes: 1,
      failures: 0,
      successRate: 1,
      evidenceRecommendationIds: [rec1.id],
    });
    // candB was only ever REJECTED — never the recommended design — so it
    // carries no realized outcome of its own: the honest cold start.
    const b = await getCandidateCalibration(owner, { candidateId: candB.id });
    expect(b).toBeNull();
    await expectCode('candidate_not_found', () =>
      getCandidateCalibration(owner, { candidateId: newId() }),
    );
    // Cross-tenant: uniformly not-found.
    await expectCode('candidate_not_found', () =>
      getCandidateCalibration(member(tenantIsoB), { candidateId: candA.id }),
    );
  });
});

// ---------------------------------------------------------------------------
// listRecommendations
// ---------------------------------------------------------------------------

describe('W135 listRecommendations (the filtered summaries)', () => {
  it('summarizes newest-first with candidate/rejected counts and AND-combined filters', async () => {
    const owner = member(tenantEvidence);
    const all = await listRecommendations(owner);
    // Newest first (rec3 was recorded last, in the recordCalibration
    // describe; deterministic clock pins order the rest).
    expect(all.map((summary) => summary.id)).toEqual([rec3Id, rec2.id, rec1.id]);
    expect(all[0]).toMatchObject({
      id: rec3Id,
      goalId: goalE.id,
      fingerprintId: fpE.fingerprintId,
      strategyId: null,
      recommendedCandidateId: candA.id,
      status: 'recorded', // never calibrates — its outcome was abandoned
      candidateCount: 2,
      rejectedCount: 1,
      knowledgeObjective: 'A probe recommendation whose outcome never realizes',
      calibratedAt: null,
    });
    expect(all[1]).toMatchObject({
      id: rec2.id,
      goalId: goalE.id,
      fingerprintId: fpE.fingerprintId,
      strategyId: null,
      recommendedCandidateId: candC.id,
      status: 'calibrated',
      candidateCount: 2,
      rejectedCount: 1,
      knowledgeObjective: 'A lean crew for the same spring window',
      calibratedAt: T_CALIBRATE_2,
    });
    expect(all[2]).toMatchObject({
      id: rec1.id,
      strategyId: strategyE.id,
      recommendedCandidateId: candA.id,
      status: 'calibrated',
      candidateCount: 2,
      rejectedCount: 1,
      calibratedAt: T_CALIBRATE_1,
    });

    // The candidate filter finds every recommendation that EVALUATED the
    // candidate — including the retired one.
    const evaluatingB = await listRecommendations(owner, { candidateId: candB.id });
    expect(evaluatingB.map((summary) => summary.id)).toEqual([rec2.id, rec1.id]);
    const evaluatingA = await listRecommendations(owner, { candidateId: candA.id });
    expect(evaluatingA.map((summary) => summary.id)).toEqual([rec3Id, rec1.id]);
    // Combined filters.
    const calibratedForC = await listRecommendations(owner, {
      candidateId: candC.id,
      status: 'calibrated',
    });
    expect(calibratedForC.map((summary) => summary.id)).toEqual([rec2.id]);
    const forGoal = await listRecommendations(owner, { goalId: goalE.id, limit: 1 });
    expect(forGoal.map((summary) => summary.id)).toEqual([rec3Id]);
    // A fingerprint no recommendation used: empty, not an error.
    const none = await listRecommendations(owner, { fingerprintId: newId() });
    expect(none).toEqual([]);
    await expectCode('invalid_query', () =>
      listRecommendations(owner, { status: 'pending' as never }),
    );
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation (ADR-0001)
// ---------------------------------------------------------------------------

describe('W135 tenant isolation (ADR-0001)', () => {
  it('keeps two tenants fully independent: same slug, no cross-tenant reads, no search leakage', async () => {
    const isoA = member(tenantIsoA);
    const isoB = member(tenantIsoB);
    // The same slug lives in both tenants.
    expect(candIsoA1.slug).toBe('solo-crew');
    expect(candIsoB1.slug).toBe('solo-crew');
    expect(candIsoA1.id).not.toBe(candIsoB1.id);
    expect(candIsoB1.tenantId).toBe(tenantIsoB);

    // Foreign candidate ids are uniformly not-found.
    await expectCode('candidate_not_found', () =>
      getCandidate(isoB, { candidateId: candIsoA1.id }),
    );
    await expectCode('candidate_not_found', () =>
      getCandidate(isoA, { candidateId: candIsoB1.id }),
    );

    // Each tenant's search sees only its own candidates.
    const inA = await searchOrganizations(isoA, {
      goalId: goalIsoA.id,
      fingerprintId: fpIsoA.fingerprintId,
    });
    expect(inA.map((result) => result.candidateId)).toEqual([candIsoA1.id, candIsoA2.id]);
    const inB = await searchOrganizations(isoB, {
      goalId: goalIsoB.id,
      fingerprintId: fpIsoB.fingerprintId,
    });
    expect(inB.map((result) => result.candidateId)).toEqual([candIsoB1.id]);

    // Lists stay scoped.
    expect(await listCandidates(isoA)).toHaveLength(2);
    expect(await listCandidates(isoB)).toHaveLength(1);
    expect(await listRecommendations(isoB)).toEqual([]);
    expect((await listRecommendations(isoA)).map((summary) => summary.id)).toEqual([recIso.id]);
  });
});
