// W044 — Tenant Isolation Verification · application-boundary sweep for the
// evidence/direction modules: observations (W004), memory (W010), freshness
// (W006), epistemics (W007), goals (W008) and attention (W051 goal-gap
// discovery).
//
// Same doctrine as the foundation sweep: two tenants, every contract driven
// for both, cross-tenant reads/writes must be uniform not-found (ADR-0001 no
// existence leaks), listings disjoint, natural keys per-tenant, and evidence
// provenance (observation/claim/belief references) may never cross tenants.
// All cross-module imports go through `@/modules/<m>/contract` only.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import { runGoalGapDiscovery, getDiscoveryRun, getDiscoveryCandidate, listDiscoveryRuns } from '@/modules/attention/contract';
import {
  formBelief,
  getBelief,
  getClaim,
  listBeliefHistory,
  listBeliefs,
  listClaims,
  listContradictions,
  listHypotheses,
  listUnknowns,
  recordClaim,
  recordHypothesis,
  recordUnknown,
  registerContradiction,
  resolveContradiction,
  resolveHypothesis,
  resolveUnknown,
  reviseBelief,
  retireBelief,
  getContradiction,
  getHypothesis,
  getUnknown,
} from '@/modules/epistemics/contract';
import {
  getFreshnessPolicy,
  getTemporalState,
  listTemporalHistory,
  evaluateObservationFreshness,
  recordTemporalRevision,
  setFreshnessPolicy,
} from '@/modules/freshness/contract';
import { createGoal, getGoal, getGoalVersion, listGoals, listGoalVersions, reviseGoal } from '@/modules/goals/contract';
import {
  getKnowledgeEntry,
  getKnowledgeEntryEvidence,
  getTransactiveEntry,
  listKnowledgeEntries,
  listTransactiveEntries,
  recordKnowledgeEntry,
  recordTransactiveEntry,
} from '@/modules/memory/contract';
import {
  getObservation,
  getObservationLineage,
  listObservations,
  recordObservation,
} from '@/modules/observations/contract';
import { startExecution } from '@/modules/cognition/contract';
import { getMission } from '@/modules/missions/contract';
import { assertTenantPartition, expectUniformNotFound, member, omnipotent, runMigrations } from './harness';

const tenantA = newId();
const tenantB = newId();
const ctxA = member(tenantA);
const ctxB = member(tenantB);

const T0 = '2026-09-14T09:15:00.000Z';
const T1 = '2026-09-14T10:15:00.000Z';
const FAR_HORIZON = '2028-06-30T00:00:00.000Z';
const PERSON_ID = '0b2f8e2a-1c4b-4d8a-9f3e-7a2b6c5d4e8f';

beforeAll(async () => {
  await runMigrations(getDb());
});

afterAll(async () => {
  await closeDb();
});

/** A canonical observation input; `secret` distinguishes tenants in payloads. */
function observationInput(secret: string, observedAt = T0) {
  return {
    kind: 'channel.message',
    payload: { text: `the printer on floor 3 is broken (${secret})` },
    observedAt,
    source: { kind: 'person' as const, label: 'office-manager' },
    channel: 'whatsapp',
    confidence: { value: 0.9, method: 'source_trust', basis: 'first-hand report' },
  };
}

// ---------------------------------------------------------------------------
// observations (W004)
// ---------------------------------------------------------------------------

describe('W044 observations — immutable evidence is tenant-scoped', () => {
  it('keeps records, lineage and listings per-tenant with uniform not-found', async () => {
    const alpha = await recordObservation(ctxA, observationInput('alpha-secret'));
    const beta = await recordObservation(ctxB, observationInput('beta-secret'));

    expect(alpha.tenantId).toBe(tenantA);
    expect(beta.tenantId).toBe(tenantB);

    await expectUniformNotFound(
      'observation_not_found',
      () => getObservation(ctxB, alpha.id),
      () => getObservation(ctxB, newId()),
    );
    await expectUniformNotFound(
      'observation_not_found',
      () => getObservationLineage(ctxB, alpha.id),
      () => getObservationLineage(ctxB, newId()),
    );

    const bFeed = await listObservations(ctxB, {});
    expect(bFeed.map((observation) => observation.id)).toContain(beta.id);
    expect(bFeed.map((observation) => observation.id)).not.toContain(alpha.id);
    expect(JSON.stringify(bFeed)).not.toContain('alpha-secret');
    const aFeed = await listObservations(ctxA, {});
    expect(JSON.stringify(aFeed)).not.toContain('beta-secret');
  });

  it('rejects lineage parents from another tenant before writing', async () => {
    const foreign = await recordObservation(ctxB, observationInput('beta-parent'));
    await expect(
      recordObservation(ctxA, {
        ...observationInput('alpha-child'),
        lineage: { method: 'extraction', parents: [foreign.id] },
      }),
    ).rejects.toMatchObject({ code: 'observation_not_found' });
  });
});

// ---------------------------------------------------------------------------
// memory (W010)
// ---------------------------------------------------------------------------

describe('W044 memory — organizational knowledge is tenant-scoped', () => {
  it('fails cross-tenant reads of knowledge and transactive entries uniformly', async () => {
    const evidence = await recordObservation(ctxA, observationInput('alpha-evidence'));
    const knowledge = await recordKnowledgeEntry(ctxA, {
      kind: 'fact',
      title: 'Northwind renewal was lost',
      summary: 'Northwind chose the competitor on price.',
      topics: ['customers', 'churn'],
      entities: [{ kind: 'customer', label: 'Northwind' }],
      evidenceObservationIds: [evidence.id],
    });
    const transactive = await recordTransactiveEntry(ctxA, {
      actor: { kind: 'person', id: newId(), label: 'alice' },
      relation: 'knows',
      subjectLabel: 'HVAC maintenance contracts',
      topics: ['hvac', 'facilities'],
      evidenceObservationIds: [evidence.id],
    });

    await expectUniformNotFound(
      'knowledge_entry_not_found',
      () => getKnowledgeEntry(ctxB, knowledge.id),
      () => getKnowledgeEntry(ctxB, newId()),
    );
    await expectUniformNotFound(
      'knowledge_entry_not_found',
      () => getKnowledgeEntryEvidence(ctxB, knowledge.id),
      () => getKnowledgeEntryEvidence(ctxB, newId()),
    );
    await expectUniformNotFound(
      'transactive_entry_not_found',
      () => getTransactiveEntry(ctxB, transactive.id),
      () => getTransactiveEntry(ctxB, newId()),
    );

    expect(await listKnowledgeEntries(ctxB, {})).toEqual([]);
    expect(await listKnowledgeEntries(ctxB, { topics: ['customers'] })).toEqual([]);
    expect(await listTransactiveEntries(ctxB, {})).toEqual([]);
    expect(await listKnowledgeEntries(ctxB, { evidenceObservationId: evidence.id })).toEqual([]);
  });

  it('rejects provenance citing another tenant evidence before writing', async () => {
    const alphaEvidence = await recordObservation(ctxA, observationInput('alpha-for-b'));
    await expect(
      recordKnowledgeEntry(ctxB, {
        kind: 'fact',
        title: 'B cites A evidence',
        summary: 'This entry must never exist.',
        topics: ['isolation'],
        evidenceObservationIds: [alphaEvidence.id],
      }),
    ).rejects.toMatchObject({ code: 'invalid_provenance' });
    await expect(
      recordTransactiveEntry(ctxB, {
        actor: { kind: 'person', label: 'beta-actor' },
        relation: 'knows',
        subjectLabel: 'Beta subject',
        topics: ['isolation'],
        evidenceObservationIds: [alphaEvidence.id],
      }),
    ).rejects.toMatchObject({ code: 'invalid_provenance' });
  });
});

// ---------------------------------------------------------------------------
// freshness (W006)
// ---------------------------------------------------------------------------

describe('W044 freshness — policies and temporal state are tenant-scoped', () => {
  it('keeps the same policy key independent per tenant', async () => {
    await setFreshnessPolicy(ctxA, { subjectKind: 'source', staleAfterSeconds: 3600 });
    await setFreshnessPolicy(ctxB, { subjectKind: 'source', staleAfterSeconds: 86_400 });

    const inA = await getFreshnessPolicy(ctxA, { subjectKind: 'source' });
    const inB = await getFreshnessPolicy(ctxB, { subjectKind: 'source' });
    expect(inA.staleAfterSeconds).toBe(3600);
    expect(inB.staleAfterSeconds).toBe(86_400);

    // A subject-specific policy of A is invisible in B (uniform policy_not_found).
    const subjectId = newId();
    await setFreshnessPolicy(ctxA, { subjectKind: 'source', subjectId, staleAfterSeconds: 60 });
    await expectUniformNotFound(
      'policy_not_found',
      () => getFreshnessPolicy(ctxB, { subjectKind: 'source', subjectId }),
      () => getFreshnessPolicy(ctxB, { subjectKind: 'source', subjectId: newId() }),
    );
  });

  it('fails cross-tenant temporal reads and provenance uniformly', async () => {
    const evidence = await recordObservation(ctxA, observationInput('alpha-temporal'));
    const subjectKind = 'world.relationship';
    const subjectId = newId();
    await recordTemporalRevision(ctxA, {
      subjectKind,
      subjectId,
      state: { strength: 'strong' },
      validFrom: T0,
      observationIds: [evidence.id],
    });

    await expectUniformNotFound(
      'temporal_state_not_found',
      () => getTemporalState(ctxB, { subjectKind, subjectId }),
      () => getTemporalState(ctxB, { subjectKind, subjectId: newId() }),
    );
    expect(await listTemporalHistory(ctxB, { subjectKind, subjectId })).toEqual([]);

    // B cannot build a revision on A's observation.
    await expect(
      recordTemporalRevision(ctxB, {
        subjectKind,
        subjectId: newId(),
        state: { strength: 'weak' },
        validFrom: T0,
        observationIds: [evidence.id],
      }),
    ).rejects.toMatchObject({ code: 'invalid_provenance' });

    // Freshness evaluation of a foreign observation propagates the
    // observations module's uniform not-found.
    await expect(
      evaluateObservationFreshness(ctxB, { observationId: evidence.id, asOf: T1 }),
    ).rejects.toMatchObject({ code: 'observation_not_found' });
  });
});

// ---------------------------------------------------------------------------
// epistemics (W007)
// ---------------------------------------------------------------------------

describe('W044 epistemics — claims, beliefs, unknowns stay tenant-scoped', () => {
  it('fails cross-tenant reads of every epistemic object uniformly', async () => {
    const evidence = await recordObservation(ctxA, observationInput('alpha-epistemics'));
    const claim = await recordClaim(ctxA, {
      proposition: 'supplier Acme delivers within five business days',
      subject: { kind: 'world.entity', id: newId() },
      confidence: { value: 0.8, method: 'evidence_weighing', basis: 'delivery notes' },
      evidenceObservationIds: [evidence.id],
    });
    const belief = await formBelief(ctxA, {
      proposition: 'supplier Acme is reliable',
      confidence: { value: 0.7, method: 'evidence_weighing' },
      supportingObservationIds: [evidence.id],
      validFrom: T0,
    });
    const unknown = await recordUnknown(ctxA, {
      question: 'which warehouse causes the delivery delays?',
      consequence: 'without it we cannot fix the delivery slips',
    });
    const hypothesis = await recordHypothesis(ctxA, {
      proposition: 'the Lyon warehouse is the bottleneck',
    });
    const contradiction = await registerContradiction(ctxA, {
      left: { kind: 'claim', id: claim.id },
      right: { kind: 'observation', id: evidence.id },
      note: 'conflicting report',
    });

    await expectUniformNotFound(
      'claim_not_found',
      () => getClaim(ctxB, { claimId: claim.id }),
      () => getClaim(ctxB, { claimId: newId() }),
    );
    await expectUniformNotFound(
      'belief_not_found',
      () => getBelief(ctxB, { beliefId: belief.id }),
      () => getBelief(ctxB, { beliefId: newId() }),
    );
    await expectUniformNotFound(
      'unknown_not_found',
      () => getUnknown(ctxB, { unknownId: unknown.id }),
      () => getUnknown(ctxB, { unknownId: newId() }),
    );
    await expectUniformNotFound(
      'hypothesis_not_found',
      () => getHypothesis(ctxB, { hypothesisId: hypothesis.id }),
      () => getHypothesis(ctxB, { hypothesisId: newId() }),
    );
    await expectUniformNotFound(
      'contradiction_not_found',
      () => getContradiction(ctxB, { contradictionId: contradiction.id }),
      () => getContradiction(ctxB, { contradictionId: newId() }),
    );

    expect(await listClaims(ctxB, {})).toEqual([]);
    expect(await listBeliefs(ctxB, {})).toEqual([]);
    expect(await listUnknowns(ctxB, {})).toEqual([]);
    expect(await listHypotheses(ctxB, {})).toEqual([]);
    expect(await listContradictions(ctxB, {})).toEqual([]);
  });

  it('rejects cross-tenant evidence references and belief mutations', async () => {
    const evidenceA = await recordObservation(ctxA, observationInput('alpha-evidence-2'));
    const claimA = await recordClaim(ctxA, {
      proposition: 'claim anchor A',
      confidence: { value: 0.6, method: 'evidence_weighing' },
      evidenceObservationIds: [evidenceA.id],
    });
    const beliefA = await formBelief(ctxA, {
      proposition: 'belief anchor A',
      confidence: { value: 0.6, method: 'evidence_weighing' },
      supportingObservationIds: [evidenceA.id],
      validFrom: T0,
    });
    const evidenceB = await recordObservation(ctxB, observationInput('beta-evidence-2'));

    // B cannot cite A's observation as evidence.
    await expect(
      recordClaim(ctxB, {
        proposition: 'B cites A observation',
        confidence: { value: 0.5, method: 'evidence_weighing' },
        evidenceObservationIds: [evidenceA.id],
      }),
    ).rejects.toMatchObject({ code: 'invalid_evidence' });

    // B cannot build a contradiction spanning A's claim and its own observation.
    await expect(
      registerContradiction(ctxB, {
        left: { kind: 'claim', id: claimA.id },
        right: { kind: 'observation', id: evidenceB.id },
        note: 'cross-tenant conflict',
      }),
    ).rejects.toMatchObject({ code: 'invalid_evidence' });

    // B cannot revise, retire or inspect the history of A's belief.
    await expect(
      reviseBelief(ctxB, {
        beliefId: beliefA.id,
        proposition: 'pwned belief',
        confidence: { value: 0.9, method: 'evidence_weighing' },
        supportingObservationIds: [evidenceB.id],
        validFrom: T1,
      }),
    ).rejects.toMatchObject({ code: 'belief_not_found' });
    await expect(
      retireBelief(ctxB, { beliefId: beliefA.id, rationale: 'cross-tenant pwn' }),
    ).rejects.toMatchObject({ code: 'belief_not_found' });
    await expect(listBeliefHistory(ctxB, { beliefId: beliefA.id })).rejects.toMatchObject({
      code: 'belief_not_found',
    });
    const readBack = await getBelief(ctxA, { beliefId: beliefA.id });
    expect(readBack.statement.proposition).toBe('belief anchor A');
  });

  it('rejects cross-tenant resolution of contradictions, hypotheses and unknowns', async () => {
    const evidenceA = await recordObservation(ctxA, observationInput('alpha-resolve'));
    const claimA = await recordClaim(ctxA, {
      proposition: 'resolve anchor A',
      confidence: { value: 0.6, method: 'evidence_weighing' },
      evidenceObservationIds: [evidenceA.id],
    });
    const contradiction = await registerContradiction(ctxA, {
      left: { kind: 'claim', id: claimA.id },
      right: { kind: 'observation', id: evidenceA.id },
      note: 'to resolve later',
    });
    const hypothesis = await recordHypothesis(ctxA, { proposition: 'hypothesis anchor A' });
    const unknown = await recordUnknown(ctxA, {
      question: 'unknown anchor A?',
      consequence: 'consequence anchor A',
    });

    await expect(
      resolveContradiction(ctxB, { contradictionId: contradiction.id, note: 'pwned' }),
    ).rejects.toMatchObject({ code: 'contradiction_not_found' });
    await expect(
      resolveHypothesis(ctxB, { hypothesisId: hypothesis.id, outcome: 'confirmed', note: 'pwned' }),
    ).rejects.toMatchObject({ code: 'hypothesis_not_found' });
    await expect(
      resolveUnknown(ctxB, { unknownId: unknown.id, note: 'pwned' }),
    ).rejects.toMatchObject({ code: 'unknown_not_found' });
  });
});

// ---------------------------------------------------------------------------
// goals (W008)
// ---------------------------------------------------------------------------

describe('W044 goals — versioned management goals are tenant-scoped', () => {
  it('fails cross-tenant reads and revisions uniformly, keeping owner filters in-tenant', async () => {
    const goalInput = () => ({
      title: 'Q4 churn reduction',
      objective: 'Reduce monthly customer churn.',
      desiredState: 'Churn is below 5% every month of the quarter.',
      metrics: [{ name: 'monthly-churn-ratio', unit: 'ratio', direction: 'at_most' as const, threshold: 0.05 }],
      horizonStart: T0,
      horizonEnd: FAR_HORIZON,
      owner: { kind: 'person' as const, id: PERSON_ID, label: 'VP Customer Success' },
      priority: 'high' as const,
      evidenceSources: [{ kind: 'source' as const, label: 'billing-export' }],
      successCriteria: 'Three consecutive months with churn at or below 5%.',
      actor: { kind: 'person' as const, id: PERSON_ID },
      rationale: 'board-2026',
    });

    const goalA = await createGoal(ctxA, goalInput());
    const goalB = await createGoal(ctxB, goalInput());
    expect(goalA.id).not.toBe(goalB.id);

    await expectUniformNotFound(
      'goal_not_found',
      () => getGoal(ctxB, goalA.id),
      () => getGoal(ctxB, newId()),
    );
    await expectUniformNotFound(
      'goal_version_not_found',
      () => getGoalVersion(ctxB, { goalId: goalA.id, version: 1 }),
      () => getGoalVersion(ctxB, { goalId: newId(), version: 1 }),
    );
    await expect(listGoalVersions(ctxB, { goalId: goalA.id })).rejects.toMatchObject({
      code: 'goal_not_found',
    });

    // Cross-tenant revision fails and never mutates A's goal.
    await expect(
      reviseGoal(ctxB, {
        goalId: goalA.id,
        title: 'Pwned by B',
        actor: { kind: 'person', id: PERSON_ID },
        rationale: 'cross-tenant write',
      }),
    ).rejects.toMatchObject({ code: 'goal_not_found' });
    expect((await getGoal(ctxA, goalA.id)).content.title).toBe('Q4 churn reduction');

    // Listings per-tenant; the SHARED owner id must not leak across tenants.
    expect((await listGoals(ctxB, {})).map((goal) => goal.id)).not.toContain(goalA.id);
    const byOwnerInA = await listGoals(ctxA, { ownerKind: 'person', ownerId: PERSON_ID });
    expect(byOwnerInA.map((goal) => goal.id)).toEqual([goalA.id]);
    const byOwnerInB = await listGoals(ctxB, { ownerKind: 'person', ownerId: PERSON_ID });
    expect(byOwnerInB.map((goal) => goal.id)).toEqual([goalB.id]);
  });
});

// ---------------------------------------------------------------------------
// attention (W051 goal-gap discovery)
// ---------------------------------------------------------------------------

describe('W044 attention — discovery runs and candidates are tenant-scoped', () => {
  it('fails cross-tenant reads of runs and candidates uniformly', async () => {
    const goal = await createGoal(ctxA, {
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
      rationale: 'W044 fixture',
    });
    const observation = await recordObservation(ctxA, {
      kind: 'metric.sample',
      payload: { metric: 'monthly-churn-rate', value: 8.4 },
      observedAt: T0,
      source: { kind: 'source', label: 'billing-crm' },
      channel: 'ingestion',
      confidence: { value: 0.85, method: 'source_trust' },
    });
    const claim = await recordClaim(ctxA, {
      proposition: 'Monthly churn rate is 8.4 percent',
      subject: { kind: 'goals.goal', id: goal.id },
      confidence: { value: 0.85, method: 'source_trust', basis: 'fixture' },
      evidenceObservationIds: [observation.id],
      rationale: 'W044 fixture',
    });

    const run = await runGoalGapDiscovery(ctxA, {
      trigger: { kind: 'scheduled', label: 'W044 isolation sweep' },
      readings: [
        {
          goalId: goal.id,
          metricName: 'monthly-churn-rate',
          value: 8.4,
          evidenceClaimIds: [claim.id],
        },
      ],
      proposals: [],
      investigationBudget: { amount: 500_00, currency: 'EUR' },
      rewardBudget: { amount: 100_00, currency: 'EUR' },
      actor: { kind: 'system', label: 'aurum-attention' },
      rationale: 'W044 isolation fixture',
    });

    const full = await getDiscoveryRun(ctxA, { runId: run.id });
    const candidate = full.candidates[0]!;

    await expectUniformNotFound(
      'run_not_found',
      () => getDiscoveryRun(ctxB, { runId: run.id }),
      () => getDiscoveryRun(ctxB, { runId: newId() }),
    );
    await expectUniformNotFound(
      'candidate_not_found',
      () => getDiscoveryCandidate(ctxB, { candidateId: candidate.id }),
      () => getDiscoveryCandidate(ctxB, { candidateId: newId() }),
    );
    expect(await listDiscoveryRuns(ctxB, {})).toHaveLength(0);

    // Promoted unknowns/missions land only in the CALLING tenant.
    if (candidate.epistemicsUnknownId !== null && candidate.epistemicsUnknownId !== undefined) {
      await expect(getUnknown(ctxB, { unknownId: candidate.epistemicsUnknownId })).rejects.toMatchObject({
        code: 'unknown_not_found',
      });
    }
    if (candidate.missionId !== null && candidate.missionId !== undefined) {
      await expect(getMission(ctxB, candidate.missionId)).rejects.toMatchObject({
        code: 'mission_not_found',
      });
    }
  });

  it('rejects discovery inputs referencing another tenant goals, claims or executions', async () => {
    const goalA = await createGoal(ctxA, {
      title: 'W044 evidence-ref guard',
      objective: 'Guard cross-tenant evidence references',
      desiredState: 'No cross-tenant references accepted',
      metrics: [{ name: 'guard-ratio', unit: 'ratio', direction: 'at_most', threshold: 0.1 }],
      horizonEnd: FAR_HORIZON,
      owner: { kind: 'person', id: PERSON_ID, label: 'COO' },
      priority: 'high',
      evidenceSources: [],
      successCriteria: 'Every foreign reference rejected',
      actor: { kind: 'person', id: PERSON_ID },
      rationale: 'W044 fixture',
    });
    const observationB = await recordObservation(ctxB, {
      kind: 'metric.sample',
      payload: { metric: 'foreign', value: 1 },
      observedAt: T0,
      source: { kind: 'source', label: 'beta-crm' },
      channel: 'ingestion',
      confidence: { value: 0.8, method: 'source_trust' },
    });
    const claimB = await recordClaim(ctxB, {
      proposition: 'Beta-only claim for cross-tenant probes',
      confidence: { value: 0.8, method: 'source_trust' },
      evidenceObservationIds: [observationB.id],
    });

    const baseRun = {
      trigger: { kind: 'scheduled' as const, label: 'W044 ref guard' },
      proposals: [],
      investigationBudget: { amount: 100_00, currency: 'EUR' },
      rewardBudget: { amount: 50_00, currency: 'EUR' },
      actor: { kind: 'system' as const, label: 'aurum-attention' },
      rationale: 'W044 fixture',
    };

    // A's run citing B's claim as evidence.
    await expect(
      runGoalGapDiscovery(ctxA, {
        ...baseRun,
        goalIds: [goalA.id],
        readings: [
          { goalId: goalA.id, metricName: 'guard-ratio', value: 0.9, evidenceClaimIds: [claimB.id] },
        ],
      }),
    ).rejects.toMatchObject({ code: 'invalid_evidence_ref' });

    // A's run scoped to a goal of tenant B (created here to keep the probe
    // self-contained): foreign and missing goal ids share the same code.
    const goalB = await createGoal(ctxB, {
      title: 'W044 beta goal',
      objective: 'Beta objective',
      desiredState: 'Beta desired state',
      horizonEnd: FAR_HORIZON,
      owner: { kind: 'person', id: PERSON_ID, label: 'COO' },
      priority: 'high',
      evidenceSources: [],
      successCriteria: 'Beta success criteria',
      actor: { kind: 'person', id: PERSON_ID },
      rationale: 'W044 fixture',
    });
    await expect(
      runGoalGapDiscovery(ctxA, { ...baseRun, goalIds: [goalB.id] }),
    ).rejects.toMatchObject({ code: 'invalid_goal_ref' });
    await expect(
      runGoalGapDiscovery(ctxA, { ...baseRun, goalIds: [newId()] }),
    ).rejects.toMatchObject({ code: 'invalid_goal_ref' });

    // A's run attributed to B's cognition execution.
    const executionB = await startExecution(ctxB, {
      trigger: { kind: 'system', label: 'beta execution' },
      focus: { topics: ['churn'], entities: [] },
      actor: { kind: 'system', label: 'aurum-cognition' },
      rationale: 'W044 fixture',
    });
    await expect(
      runGoalGapDiscovery(ctxA, { ...baseRun, originExecutionId: executionB.id }),
    ).rejects.toMatchObject({ code: 'invalid_origin_ref' });

    // The omnipotent principal of B cannot read A's run either.
    const runA = await runGoalGapDiscovery(ctxA, { ...baseRun, readings: [] });
    await expect(getDiscoveryRun(omnipotent(tenantB), { runId: runA.id })).rejects.toMatchObject({
      code: 'run_not_found',
    });
  });
});

// ---------------------------------------------------------------------------
// Row-partition integrity over the whole migrated schema
// ---------------------------------------------------------------------------

describe('W044 repository boundary — row partition integrity', () => {
  it('stores every row of every tenant-scoped table under a sweep tenant only', async () => {
    await assertTenantPartition([tenantA, tenantB]);
  });
});
