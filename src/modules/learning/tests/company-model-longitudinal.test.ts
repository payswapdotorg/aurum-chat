// W053 longitudinal fixture — ADR-0016's Required verification:
//
//   "A longitudinal fixture must show that repeated work on the same
//    synthetic company causes measurable improvement in source selection,
//    unknown resolution efficiency or intervention recommendation quality
//    without changing the explicit policy."
//
// Design (spec/LONGITUDINAL-BENCHMARK.md, normative shape):
//  * ONE synthetic company instantiated TWICE — an EXPERIENCED Aurum
//    tenant (records a learning update after every mission) and a COLD-START
//    tenant (never records anything) — with identical information
//    environments: the same four internal sources with the same hidden
//    qualities, the same seeded per-round noise, and the SAME frozen
//    explicit policy on every single call.
//  * Each round is one investigation mission: rankCandidates (domain
//    source_selection, policy-constrained), then walk the ranked list
//    querying sources until the mission's evidence-quality threshold is
//    reached; every query's observed usefulness is recorded as a W040
//    measurement with evidence, the mission outcome is settled on the
//    accumulated evidence, and — for the experienced tenant ONLY — a
//    recorded learning update teaches every queried source's reliability
//    FROM that mission's outcome and evidence.
//
// Measured: median investigation steps per resolved mission (unknown
// resolution efficiency) and first-choice source quality (source selection).
//
// The benchmark's failure conditions are all structurally excluded and
// asserted:
//  * policy is never relaxed — one frozen policy object, the same reference
//    on every call, and the policy's exclusions/precedence hold in every
//    round even against maximally learned preferences;
//  * no ground-truth leakage — the hidden qualities live only in this
//    fixture; the learning module ever sees only observed usefulness
//    arriving through outcomes and evidence;
//  * no provider-specific hidden state — the CompanyModel is the only
//    channel and is provider-neutral by construction;
//  * the experienced instance improves strictly through recorded
//    CompanyModel deltas attributable to evidence and outcomes — asserted
//    by resolving every applied prior of the final ranking back to its
//    assertion version, its recorded update and that update's linked
//    outcome.
//
// Determinism: the fixture uses a seeded PRNG (same seed per round for both
// tenants) and thresholds chosen so every measured outcome is exact:
//  * cold start ALWAYS resolves in 4 steps with the Wiki first (0.55):
//    Wiki+Sheets+ERP ∈ [1.26, 1.54] < 1.6 forces the CRM query;
//  * the experienced instance resolves in ≤ 3 steps from round 2 on and in
//    exactly 4 in round 1 (identical to cold — no model yet), with the CRM
//    (0.95) first from round 2 on: its round-1 reliability prior blends to
//    ≥ 0.695 while every rival stays ≤ 0.588.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import * as learningContract from '../contract';
import type { CompanyModelRanking, RankedCandidate } from '../types';
import { runMigrations } from '../../../../scripts/migrate';

const {
  defineOutcome,
  getCompanyModel,
  getCompanyModelAssertion,
  getLearningUpdate,
  rankCandidates,
  recordLearningUpdate,
  recordMeasurement,
  settleOutcome,
} = learningContract;

// The two instances of the same synthetic company.
const experienced: InstanceState = { observations: new Map(), metrics: [] };
const cold: InstanceState = { observations: new Map(), metrics: [] };

// ---------------------------------------------------------------------------
// The synthetic company (hidden ground truth — never leaves this file)
// ---------------------------------------------------------------------------

const SOURCE_WIKI = 'd2e3f4a5-b6c7-4d8e-9f0a-1b2c3d4e5f6a';
const SOURCE_SHEETS = 'e3f4a5b6-c7d8-4e9f-8a0b-2c3d4e5f6a7b';
const SOURCE_ERP = 'b1a2c3d4-e5f6-4a7b-8c9d-9f0a1b2c3d4e';
const SOURCE_CRM = 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f';
const DANA_ID = '0b2f8e2a-1c4b-4d8a-9f3e-7a2b6c5d4e8f';
const AGENT_ID = '3c5e1a7f-4b6d-4c8e-9d0a-1e3f5a7c9e1b';

interface CandidateSpec {
  key: string;
  kind: 'source' | 'employee' | 'agent';
  id: string;
  label: string;
  /** Hidden answer quality — the ground truth the model must never see directly. */
  hiddenQuality: number;
}

/** The candidate menu: four internal systems, one internal expert, one agent. */
const CANDIDATES: CandidateSpec[] = [
  { key: `source:${SOURCE_WIKI}`, kind: 'source', id: SOURCE_WIKI, label: 'Company Wiki', hiddenQuality: 0.55 },
  { key: `source:${SOURCE_SHEETS}`, kind: 'source', id: SOURCE_SHEETS, label: 'Spreadsheets', hiddenQuality: 0.25 },
  { key: `source:${SOURCE_ERP}`, kind: 'source', id: SOURCE_ERP, label: 'ERP', hiddenQuality: 0.6 },
  { key: `source:${SOURCE_CRM}`, kind: 'source', id: SOURCE_CRM, label: 'CRM', hiddenQuality: 0.95 },
  { key: `employee:${DANA_ID}`, kind: 'employee', id: DANA_ID, label: 'Dana (controller)', hiddenQuality: 0.75 },
  { key: `agent:${AGENT_ID}`, kind: 'agent', id: AGENT_ID, label: 'Research agent', hiddenQuality: 0.99 },
];

const CRM = CANDIDATES[3]!;
const WIKI = CANDIDATES[0]!;

/**
 * The EXPLICIT POLICY — frozen and never changed between rounds (the
 * benchmark's first failure condition). Agents are not permitted for these
 * missions, and internal systems must always be consulted before people.
 */
const POLICY = Object.freeze({
  allowedKinds: Object.freeze(['source', 'employee']),
  kindPrecedence: Object.freeze(['source', 'employee']),
});

/** A mission resolves once this much evidence quality is gathered. */
const RESOLVE_THRESHOLD = 1.6;
/** Repeated-work rounds (month-like cycles on the same company). */
const ROUNDS = 6;

/** Deterministic PRNG (mulberry32) — the same seeded world per round. */
function mulberry32(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// The longitudinal loop
// ---------------------------------------------------------------------------

interface RoundMetric {
  round: number;
  steps: number;
  firstChoiceKey: string;
  firstChoiceQuality: number;
  accumulated: number;
  outcomeId: string;
  updateId: string | null;
  policyReference: typeof POLICY;
}

interface InstanceState {
  /** Observed usefulness history per candidate key (the learner's only input). */
  observations: Map<string, number[]>;
  metrics: RoundMetric[];
}

const tenantExperienced = newId();
const tenantCold = newId();

function member(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: [] };
}

/**
 * One investigation mission on one instance. `learning` is true only for
 * the experienced tenant: after resolving, it records a learning update
 * citing the mission's evidence and its settled outcome — the only channel
 * through which behavior may improve (ADR-0016/ADR-0019).
 */
async function runRound(
  ctx: TenantContext,
  state: InstanceState,
  round: number,
  learning: boolean,
): Promise<RoundMetric> {
  const rng = mulberry32(0x5eed0000 + round); // same world for both instances

  // 1. Rank the candidate menu under the frozen explicit policy.
  const ranking: CompanyModelRanking = await rankCandidates(ctx, {
    domain: 'source_selection',
    candidates: CANDIDATES.map((spec) => ({ kind: spec.kind, id: spec.id, label: spec.label, baseScore: 0.5 })),
    policy: POLICY,
  });

  // 2. Walk the ranked list (policy-excluded candidates are never queried):
  //    each query yields observed usefulness q·(1 ± 10%).
  let accumulated = 0;
  let steps = 0;
  const queried: Array<{ spec: CandidateSpec; usefulness: number }> = [];
  for (const candidate of ranking.candidates) {
    if (candidate.policyExcluded) continue;
    const spec = CANDIDATES.find((entry) => entry.key === candidate.key)!;
    const usefulness = spec.hiddenQuality * (1 + 0.2 * (rng() - 0.5));
    steps += 1;
    accumulated += usefulness;
    queried.push({ spec, usefulness });
    if (accumulated >= RESOLVE_THRESHOLD) break;
  }

  // 3. The mission outcome: every query is a measurement with evidence;
  //    the settlement is grounded in the accumulated total.
  const outcome = await defineOutcome(ctx, {
    subject: { kind: 'mission', id: newId(), label: `Round ${round} investigation` },
    metricName: 'investigation evidence quality',
    metricUnit: 'quality-points',
    direction: 'at_least',
    baseline: 0,
    expected: RESOLVE_THRESHOLD,
    horizon: null,
    affectedGoals: [],
    originExecutionId: null,
    actor: { kind: 'system', label: 'cognition' },
    rationale: `longitudinal fixture round ${round}`,
  });
  let lastMeasurementId = '';
  for (const { spec, usefulness } of queried) {
    const measurement = await recordMeasurement(ctx, {
      outcomeId: outcome.id,
      value: usefulness,
      note: `${spec.label} answer`,
      evidence: [{ kind: 'system', id: spec.id, label: spec.label }],
      actor: { kind: 'system', label: 'investigator' },
    });
    lastMeasurementId = measurement.id;
  }
  const total = await recordMeasurement(ctx, {
    outcomeId: outcome.id,
    value: accumulated,
    note: 'total evidence quality gathered',
    evidence: queried.map(({ spec }) => ({ kind: 'system', id: spec.id, label: spec.label })),
    actor: { kind: 'system', label: 'investigator' },
  });
  await settleOutcome(ctx, {
    outcomeId: outcome.id,
    measurementId: total.id,
    note: `round ${round} resolved in ${steps} steps`,
    actor: { kind: 'system', label: 'investigator' },
  });
  expect(lastMeasurementId).not.toBe('');

  // 4. Learning (experienced only): one recorded update teaching every
  //    queried candidate's reliability, citing evidence AND the outcome.
  let updateId: string | null = null;
  if (learning && queried.length > 0) {
    const changes = queried.map(({ spec, usefulness }) => {
      const history = [...(state.observations.get(spec.key) ?? []), usefulness];
      state.observations.set(spec.key, history);
      const mean = history.reduce((sum, value) => sum + value, 0) / history.length;
      return {
        area: 'source_reliability' as const,
        subject:
          spec.kind === 'employee'
            ? ({ kind: 'employee' as const, id: spec.id, label: spec.label } as const)
            : ({ kind: 'source' as const, id: spec.id, label: spec.label } as const),
        topic: 'reliability',
        statement: { score: Math.min(1, mean) },
        confidence: Math.min(0.9, 0.4 + 0.15 * history.length),
        evidence: [{ kind: 'observation' as const, label: `round-${round} ${spec.label} query` }],
        outcomeId: outcome.id,
      };
    });
    const update = await recordLearningUpdate(ctx, {
      changes,
      rationale: `round ${round}: source reliability learned from mission outcome evidence`,
      actor: { kind: 'system', label: 'cognition' },
    });
    updateId = update.id;
  }

  const first = queried[0]!;
  state.metrics.push({
    round,
    steps,
    firstChoiceKey: first.spec.key,
    firstChoiceQuality: first.spec.hiddenQuality,
    accumulated,
    outcomeId: outcome.id,
    updateId,
    policyReference: POLICY,
  });
  return state.metrics[state.metrics.length - 1]!;
}

beforeAll(async () => {
  await runMigrations(getDb());

  // Run both instances over the same company, round by round.
  for (let round = 1; round <= ROUNDS; round += 1) {
    await runRound(member(tenantExperienced), experienced, round, true);
    await runRound(member(tenantCold), cold, round, false);
  }
});

afterAll(async () => {
  await closeDb();
});

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

// ---------------------------------------------------------------------------
// The ADR-0016 verification
// ---------------------------------------------------------------------------

describe('W053 longitudinal fixture — measurable improvement, unchanged policy', () => {

  it('round 1 is identical for both instances — no model, same behavior', () => {
    // Before any learning the two instances are behaviorally identical:
    // whatever improvement appears later can only come from recorded
    // CompanyModel updates.
    expect(experienced.metrics[0]!.steps).toBe(cold.metrics[0]!.steps);
    expect(experienced.metrics[0]!.steps).toBe(4);
    expect(experienced.metrics[0]!.firstChoiceKey).toBe(WIKI.key);
    expect(cold.metrics[0]!.firstChoiceKey).toBe(WIKI.key);
  });

  it('the cold-start instance never improves (no recorded updates, ever)', async () => {
    expect(cold.metrics).toHaveLength(ROUNDS);
    for (const metric of cold.metrics) {
      expect(metric.steps).toBe(4); // Wiki → Sheets → ERP → CRM, every round
      expect(metric.firstChoiceKey).toBe(WIKI.key);
      expect(metric.firstChoiceQuality).toBe(0.55);
      expect(metric.updateId).toBeNull();
    }
    const model = await getCompanyModel(member(tenantCold), {});
    expect(model.modelVersion).toBe(0);
    expect(model.assertions).toEqual([]);
  });

  it('the experienced instance measurably improves: fewer steps, better first choice', () => {
    // Unknown resolution efficiency: every post-learning round resolves in
    // at most 3 steps (vs the cold start's constant 4).
    const learnedSteps = experienced.metrics.slice(1).map((metric) => metric.steps);
    for (const steps of learnedSteps) expect(steps).toBeLessThan(4);
    // Median improvement is strict and exact.
    expect(median(learnedSteps)).toBeLessThan(median(cold.metrics.map((metric) => metric.steps)));
    expect(median(learnedSteps)).toBe(3);
    expect(median(cold.metrics.map((metric) => metric.steps))).toBe(4);

    // Source selection: the first choice becomes the CRM (hidden quality
    // 0.95) from round 2 on — the round-1 reliability prior blended at
    // confidence 0.55 already outweighs every rival — and the trajectory
    // of first-choice quality is non-decreasing.
    for (const metric of experienced.metrics.slice(1)) {
      expect(metric.firstChoiceKey).toBe(CRM.key);
      expect(metric.firstChoiceQuality).toBe(0.95);
    }
    const qualities = experienced.metrics.map((metric) => metric.firstChoiceQuality);
    for (let index = 1; index < qualities.length; index += 1) {
      expect(qualities[index]).toBeGreaterThanOrEqual(qualities[index - 1]!);
    }

    // Total investigation effort dropped (repeated-task improvement).
    const experiencedTotal = experienced.metrics.reduce((sum, metric) => sum + metric.steps, 0);
    const coldTotal = cold.metrics.reduce((sum, metric) => sum + metric.steps, 0);
    expect(experiencedTotal).toBeLessThan(coldTotal);
  });

  it('the improvement arises from recorded CompanyModel updates only', async () => {
    const ctx = member(tenantExperienced);
    // One recorded update per round, each linked to that round's outcome.
    expect(experienced.metrics.map((metric) => metric.updateId)).not.toContain(null);
    const model = await getCompanyModel(ctx, {});
    expect(model.modelVersion).toBe(ROUNDS);

    for (const metric of experienced.metrics) {
      const update = await getLearningUpdate(ctx, metric.updateId!);
      expect(update.modelVersion).toBe(metric.round);
      expect(update.rationale).toBe(`round ${metric.round}: source reliability learned from mission outcome evidence`);
      expect(update.linkedOutcomeIds).toEqual([metric.outcomeId]);
      expect(update.changes.length).toBeGreaterThanOrEqual(1);
    }

    // Every applied prior of the final ranking resolves to a recorded
    // assertion version whose provenance cites evidence AND the outcome it
    // was learned from (the benchmark's attribution requirement).
    const ranking = await rankCandidates(ctx, {
      domain: 'source_selection',
      candidates: CANDIDATES.map((spec) => ({ kind: spec.kind, id: spec.id, label: spec.label, baseScore: 0.5 })),
      policy: POLICY,
    });
    expect(ranking.modelVersion).toBe(ROUNDS);
    const withPriors = ranking.candidates.filter((candidate) => candidate.appliedPrior !== null);
    expect(withPriors.length).toBeGreaterThanOrEqual(3); // wiki, erp, crm at least
    for (const candidate of withPriors) {
      const assertion = await getCompanyModelAssertion(ctx, candidate.appliedPrior!.assertionId);
      expect(assertion.status).toBe('active');
      expect(assertion.version).toBe(candidate.appliedPrior!.version);
      expect(assertion.provenance.outcomeId).not.toBeNull();
      expect(assertion.provenance.evidence.length).toBeGreaterThan(0);
      const update = await getLearningUpdate(ctx, assertion.updateId);
      expect(update.linkedOutcomeIds).toContain(assertion.provenance.outcomeId);
    }
    // The CRM's prior is the one driving the improvement.
    const crm = ranking.candidates.find((candidate) => candidate.key === CRM.key)!;
    expect(crm.rank).toBe(1);
    expect(crm.appliedPrior).not.toBeNull();
    expect(crm.appliedPrior!.confidence).toBeGreaterThan(0.5);
  });

  it('the explicit policy was never changed and always holds', async () => {
    const ctx = member(tenantExperienced);

    // The SAME frozen policy object was passed on every call of every round.
    expect(Object.isFrozen(POLICY)).toBe(true);
    expect(Object.isFrozen(POLICY.allowedKinds)).toBe(true);
    expect(Object.isFrozen(POLICY.kindPrecedence)).toBe(true);
    for (const metric of [...experienced.metrics, ...cold.metrics]) {
      expect(Object.is(metric.policyReference, POLICY)).toBe(true);
    }

    // Policy held in every round of both instances: the agent was always
    // excluded and last, people were always ranked after systems, and the
    // surface never added or removed candidates.
    const policyCompliance = async (tenantId: string): Promise<void> => {
      const ranking = await rankCandidates(member(tenantId), {
        domain: 'source_selection',
        candidates: CANDIDATES.map((spec) => ({ kind: spec.kind, id: spec.id, label: spec.label, baseScore: 0.5 })),
        policy: POLICY,
      });
      expect(ranking.candidates).toHaveLength(CANDIDATES.length);
      const keys = new Set(ranking.candidates.map((candidate) => candidate.key));
      for (const spec of CANDIDATES) expect(keys.has(spec.key)).toBe(true);
      const agent = ranking.candidates.find((candidate) => candidate.kind === 'agent')!;
      expect(agent.policyExcluded).toBe(true);
      expect(ranking.candidates[ranking.candidates.length - 1]!.key).toBe(agent.key);
      const firstEmployee = ranking.candidates.findIndex((candidate) => candidate.kind === 'employee');
      const lastSource = ranking.candidates.map((candidate) => candidate.kind).lastIndexOf('source');
      expect(lastSource).toBeLessThan(firstEmployee);
    };
    await policyCompliance(tenantExperienced);
    await policyCompliance(tenantCold);

    // The strongest form: teach MAXIMALLY learned preferences that policy
    // forbids to prefer — the employee expert outranking every system, and
    // the (policy-forbidden) research agent being near-perfect — and the
    // ranking still obeys policy. Learned preference never overrides
    // explicit policy (lock 14).
    const outcome = await defineOutcome(ctx, {
      subject: { kind: 'recommendation', id: newId(), label: 'Policy stress recommendation' },
      metricName: 'policy stress',
      metricUnit: 'points',
      direction: 'at_least',
      baseline: 0,
      expected: 1,
      horizon: null,
      affectedGoals: [],
      originExecutionId: null,
      actor: { kind: 'system', label: 'cognition' },
      rationale: 'W053 policy-authority stress fixture',
    });
    const stressMeasurement = await recordMeasurement(ctx, {
      outcomeId: outcome.id,
      value: 1,
      note: 'stress',
      evidence: [{ kind: 'system', label: 'stress harness' }],
      actor: { kind: 'system', label: 'harness' },
    });
    await settleOutcome(ctx, {
      outcomeId: outcome.id,
      measurementId: stressMeasurement.id,
      note: 'stress settled',
      actor: { kind: 'system', label: 'harness' },
    });
    await recordLearningUpdate(ctx, {
      changes: [
        {
          area: 'source_reliability',
          subject: { kind: 'employee', id: DANA_ID, label: 'Dana (controller)' },
          topic: 'reliability',
          statement: { score: 0.99 },
          confidence: 0.95,
          evidence: [],
          outcomeId: outcome.id,
        },
        {
          area: 'source_reliability',
          subject: { kind: 'agent', id: AGENT_ID, label: 'Research agent' },
          topic: 'reliability',
          statement: { score: 0.99 },
          confidence: 1,
          evidence: [],
          outcomeId: outcome.id,
        },
      ],
      rationale: 'policy stress: maximally learned preferences that policy must still outrank',
      actor: { kind: 'system', label: 'harness' },
    });

    const stressed: CompanyModelRanking = await rankCandidates(ctx, {
      domain: 'source_selection',
      candidates: CANDIDATES.map((spec) => ({ kind: spec.kind, id: spec.id, label: spec.label, baseScore: 0.5 })),
      policy: POLICY,
    });
    const ranked: RankedCandidate[] = stressed.candidates;
    // the agent learned a perfect 0.99 at confidence 1 — still excluded, still last
    const stressedAgent = ranked.find((candidate) => candidate.kind === 'agent')!;
    expect(stressedAgent.policyExcluded).toBe(true);
    expect(stressedAgent.appliedPrior).not.toBeNull();
    expect(stressedAgent.score).toBe(0.99);
    expect(ranked[ranked.length - 1]!.key).toBe(stressedAgent.key);
    // Dana learned 0.99 at confidence 0.95 (score ≈ 0.9455) — above every
    // system's learned score — and still ranks below ALL of them (tier 1).
    const dana = ranked.find((candidate) => candidate.kind === 'employee')!;
    expect(dana.appliedPrior).not.toBeNull();
    expect(dana.score).toBeGreaterThan(CRM.key === ranked[0]!.key ? 0.8 : 0.5);
    const lastSourceIndex = ranked.map((candidate) => candidate.kind).lastIndexOf('source');
    expect(ranked.indexOf(dana)).toBeGreaterThan(lastSourceIndex);
    // and the mission-driving CRM ranking is unchanged by the stress update
    expect(ranked[0]!.key).toBe(CRM.key);
  });
});
