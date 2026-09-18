// W044 — Tenant Isolation Verification · application-boundary sweep for the
// evidence/direction modules: observations (W004), memory (W010), freshness
// (W006), epistemics (W007), goals (W008), attention (W051 goal-gap
// discovery), contributions (W042), environment (W014 watch), outcomes (W054
// intervention learning) and quality (W055 measurement).
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
import type { TenantContext } from '@/infra/tenant';
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
import {
  getContribution,
  getValidation,
  listContributions,
  listValidations,
  recordContribution,
  recordImpact,
  summarizeContributions,
  validateContribution,
} from '@/modules/contributions/contract';
import {
  addWatchEntry,
  createWatchlist,
  evaluateWatchFreshness,
  getWatchEntry,
  getWatchEscalation,
  getWatchSignal,
  getWatchlist,
  listWatchEntries,
  listWatchEscalations,
  listWatchSignals,
  listWatchlists,
  recordWatchSignal,
  setWatchEntryStatus,
  setWatchlistStatus,
  updateWatchEntry,
  updateWatchlist,
} from '@/modules/environment/contract';
import {
  abandonIntervention,
  getIntervention,
  getInterventionPriors,
  listInterventionPriorVersions,
  listInterventions,
  realizeIntervention,
  recordIntervention,
} from '@/modules/outcomes/contract';
import {
  computeQualitySnapshot,
  getJudgment,
  getQualitySnapshot,
  listJudgments,
  listQualitySnapshots,
  recordJudgment,
} from '@/modules/quality/contract';
import type { UnknownDiscoveryPayload } from '@/modules/quality/contract';
import { startExecution } from '@/modules/cognition/contract';
import { createMission, getMission } from '@/modules/missions/contract';
import {
  IDENTITY_AUTHORITY_ATTEST,
  IDENTITY_AUTHORITY_LINK,
  attestIdentity,
  registerExternalIdentity,
} from '@/modules/identity/contract';
import { defineOutcome, recordMeasurement, settleOutcome } from '@/modules/learning/contract';
import { planNextAcquisition, recordAcquisitionOutcome } from '@/modules/knowledge-acquisition/contract';
import { createEmployee, createPerson, linkExternalIdentity } from '@/modules/people/contract';
import { createEntity } from '@/modules/world/contract';
import {
  assertTenantPartition,
  expectUniformNotFound,
  member,
  memberWith,
  omnipotent,
  runMigrations,
} from './harness';

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
// Shared fixtures of the contributions / environment / outcomes / quality
// sections (built through the owning modules' contracts only)
// ---------------------------------------------------------------------------

/** A disarmed escalation policy at the lowest severity floor (W014). */
function watchPolicy() {
  return {
    signalSeverityFloor: 'low' as const,
    staleGraceSeconds: null,
    staleSeverity: null,
    notifyParties: [{ kind: 'person' as const, label: 'COO' }],
    proposeMission: false,
  };
}

/** A canonical learning-outcome definition; identical in both tenants. */
function outcomeFixture() {
  return {
    subject: { kind: 'mission' as const, id: newId(), label: 'W044 intervention subject' },
    metricName: 'onboarding time',
    metricUnit: 'days',
    direction: 'at_least' as const,
    baseline: 14,
    expected: 7,
    actor: { kind: 'person' as const, id: newId() },
    rationale: 'W044 fixture',
  };
}

let slackAccountCounter = 0;

/**
 * The full W012 → W042 chain a contribution anchors to, built through
 * contracts only: one askable employee (person + active employment + verified
 * linked identity — the attest/link steps need the identity authority
 * claims), one mission naming that employee, one planned ask-person
 * acquisition and its answered outcome.
 */
async function seedAnsweredAsk(ctx: TenantContext, fullName: string) {
  const manager = memberWith(ctx.tenantId, [IDENTITY_AUTHORITY_ATTEST, IDENTITY_AUTHORITY_LINK]);
  const person = await createPerson(ctx, { fullName });
  await createEmployee(ctx, { personId: person.id, title: `VP ${fullName}` });
  slackAccountCounter += 1;
  const registered = await registerExternalIdentity(ctx, {
    provider: 'slack',
    providerAccountId: `w044-evidence-${slackAccountCounter}`,
  });
  const attested = await attestIdentity(manager, {
    identityId: registered.identity.id,
    evidence: `W044 attestation for ${fullName}`,
  });
  await linkExternalIdentity(manager, { personId: person.id, identityId: attested.id });

  const mission = await createMission(ctx, {
    title: 'W044 contribution anchor',
    knowledgeObjective: 'Why did churn rise in Q3?',
    informationValue: 0.8,
    urgency: 'high',
    currentConfidence: 0.1,
    targetConfidence: 0.85,
    investigationBudget: { amount: 250_00, currency: 'EUR' },
    rewardBudget: { amount: 50_00, currency: 'EUR' },
    candidateSources: [{ kind: 'person', id: person.id, label: `VP ${fullName}` }],
    completionCriteria: 'A validated root-cause explanation.',
    actor: { kind: 'person', id: newId() },
    rationale: 'W044 fixture',
  });
  const planned = await planNextAcquisition(ctx, {
    missionId: mission.id,
    candidates: [
      {
        kind: 'person',
        id: person.id,
        label: `VP ${fullName}`,
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
    rationale: 'W044 fixture',
  });
  return recordAcquisitionOutcome(ctx, {
    planId: planned.id,
    outcome: 'answered',
    evidence: {
      payload: { answer: `${fullName}: pricing drove the churn spike` },
      confidence: { value: 0.8, method: 'source_trust', basis: 'direct account' },
    },
  });
}

/** A light W012 plan (system candidate — no identity chain), readable in `ctx`. */
async function seedSystemPlan(ctx: TenantContext) {
  const mission = await createMission(ctx, {
    title: 'W044 quality plan anchor',
    knowledgeObjective: 'Which system explains the billing anomaly?',
    informationValue: 0.8,
    urgency: 'medium',
    currentConfidence: 0.1,
    targetConfidence: 0.8,
    investigationBudget: { amount: 100_00, currency: 'EUR' },
    rewardBudget: { amount: 20_00, currency: 'EUR' },
    candidateSources: [{ kind: 'system', label: 'billing-export' }],
    completionCriteria: 'The anomaly is explained with evidence.',
    actor: { kind: 'person', id: newId() },
    rationale: 'W044 fixture',
  });
  return planNextAcquisition(ctx, {
    missionId: mission.id,
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
    rationale: 'W044 fixture',
  });
}

// ---------------------------------------------------------------------------
// contributions (W042)
// ---------------------------------------------------------------------------

describe('W044 contributions — employee knowledge contributions are tenant-scoped', () => {
  it('anchors the same answered acquisition independently per tenant with uniform not-found', async () => {
    // The SAME employee name, mission title, question, summary and impact in
    // both tenants: one business event, two independent records.
    const planA = await seedAnsweredAsk(ctxA, 'Grace Hopper');
    const planB = await seedAnsweredAsk(ctxB, 'Grace Hopper');
    const contributionInput = (planId: string) => ({
      planId,
      summary: 'Pricing tier changes drove Q3 churn.',
      actor: { kind: 'system' as const, label: 'aurum-cognition' },
    });

    const contributionA = await recordContribution(ctxA, contributionInput(planA.id));
    const contributionB = await recordContribution(ctxB, contributionInput(planB.id));
    expect(contributionA.tenantId).toBe(tenantA);
    expect(contributionB.tenantId).toBe(tenantB);
    expect(contributionA.id).not.toBe(contributionB.id);
    expect(contributionA.summary).toBe(contributionB.summary);
    expect(contributionA.question).toContain('churn');

    // One contribution per acquisition is a per-tenant namespace: A's plan
    // is already anchored and B's never interfered.
    await expect(
      recordContribution(ctxA, contributionInput(planA.id)),
    ).rejects.toMatchObject({ code: 'contribution_conflict' });

    const validationA = await validateContribution(ctxA, {
      contributionId: contributionA.id,
      outcome: 'validated',
      quality: 0.8,
      actor: { kind: 'system', label: 'aurum-cognition' },
    });
    const validationB = await validateContribution(ctxB, {
      contributionId: contributionB.id,
      outcome: 'validated',
      quality: 0.8,
      actor: { kind: 'system', label: 'aurum-cognition' },
    });

    await expectUniformNotFound(
      'contribution_not_found',
      () => getContribution(ctxB, contributionA.id),
      () => getContribution(ctxB, newId()),
    );
    await expectUniformNotFound(
      'validation_not_found',
      () => getValidation(ctxB, validationA.id),
      () => getValidation(ctxB, newId()),
    );

    const inA = await listContributions(ctxA, {});
    const inB = await listContributions(ctxB, {});
    expect(inA.map((contribution) => contribution.id)).toContain(contributionA.id);
    expect(inA.map((contribution) => contribution.id)).not.toContain(contributionB.id);
    expect(inB.map((contribution) => contribution.id)).toContain(contributionB.id);
    expect(inB.map((contribution) => contribution.id)).not.toContain(contributionA.id);
    // The SHARED contributor identity must not leak across tenants either.
    expect(await listContributions(ctxB, { personId: contributionA.contributor.id })).toEqual([]);
    await expect(
      listValidations(ctxB, { contributionId: contributionA.id }),
    ).rejects.toMatchObject({ code: 'contribution_not_found' });
    expect(
      (await listValidations(ctxB, { contributionId: contributionB.id })).map((validation) => validation.id),
    ).toContain(validationB.id);

    // Identical measured impacts in both tenants; the rollup of each counts
    // exactly its own (a leak would double the sums).
    const impactInput = (contributionId: string) => ({
      contributionId,
      missionImpact: 'advanced' as const,
      confidenceBefore: 0.1,
      confidenceAfter: 0.55,
      affectedGoals: [{ goalId: newId(), label: 'Q4 churn reduction' }],
      avoidedCost: 120_00,
      avoidedPaths: [{ action: 'query-system' as const, label: 'billing-export full scan', estimatedCost: 80_00 }],
      outcomeId: null,
      note: null,
      actor: { kind: 'system' as const, label: 'aurum-cognition' },
    });
    const measuredA = await recordImpact(ctxA, impactInput(contributionA.id));
    const measuredB = await recordImpact(ctxB, impactInput(contributionB.id));
    expect(measuredA.status).toBe('measured');
    expect(measuredB.status).toBe('measured');

    expect(await summarizeContributions(ctxA, {})).toEqual(await summarizeContributions(ctxB, {}));
    const summaryB = await summarizeContributions(ctxB, {});
    expect(summaryB.total).toBe(1);
    expect(summaryB.measured).toBe(1);
    expect(summaryB.missionsAdvanced).toBe(1);
    expect(summaryB.costAvoidedByCurrency).toEqual([
      { currency: 'EUR', contributions: 1, avoidedCost: 120_00 },
    ]);
  });

  it('rejects cross-tenant validation, measurement and anchoring uniformly, leaving A untouched', async () => {
    const planA = await seedAnsweredAsk(ctxA, 'Alan Turing');
    const contributionA = await recordContribution(ctxA, {
      planId: planA.id,
      summary: 'Alan answered the delivery-delay question.',
      actor: { kind: 'system', label: 'aurum-cognition' },
    });

    // B cannot validate or measure A's contribution — uniform not-found.
    await expect(
      validateContribution(ctxB, {
        contributionId: contributionA.id,
        outcome: 'rejected',
        quality: 0.1,
        actor: { kind: 'system', label: 'aurum-cognition' },
      }),
    ).rejects.toMatchObject({ code: 'contribution_not_found' });
    await expect(
      recordImpact(ctxB, {
        contributionId: contributionA.id,
        missionImpact: 'resolved',
        confidenceBefore: 0.1,
        confidenceAfter: 0.9,
        avoidedCost: 1,
        actor: { kind: 'system', label: 'aurum-cognition' },
      }),
    ).rejects.toMatchObject({ code: 'contribution_not_found' });

    // A's contribution was never touched by B's probes.
    const still = await getContribution(ctxA, contributionA.id);
    expect(still.status).toBe('pending');
    expect(still.validationCount).toBe(0);
    expect(still.impact).toBeNull();
    expect(await listValidations(ctxA, { contributionId: contributionA.id })).toEqual([]);

    // B cannot anchor a contribution to A's plan (or a missing one).
    await expectUniformNotFound(
      'invalid_plan_ref',
      () => recordContribution(ctxB, {
        planId: planA.id,
        summary: 'B forges an anchor into A.',
        actor: { kind: 'system', label: 'aurum-cognition' },
      }),
      () => recordContribution(ctxB, {
        planId: newId(),
        summary: 'B cites a missing plan.',
        actor: { kind: 'system', label: 'aurum-cognition' },
      }),
    );
    expect((await listContributions(ctxB, {})).map((contribution) => contribution.planId)).not.toContain(planA.id);
  });

  it('rejects foreign learning-outcome links and authority claims never widen scope', async () => {
    const outcomeA = await defineOutcome(ctxA, outcomeFixture());
    const planB = await seedAnsweredAsk(ctxB, 'Edsger Dijkstra');
    const contributionB = await recordContribution(ctxB, {
      planId: planB.id,
      summary: 'Beta contribution for the outcome-ref probe.',
      actor: { kind: 'system', label: 'aurum-cognition' },
    });
    const impactInput = (outcomeId: string) => ({
      contributionId: contributionB.id,
      missionImpact: 'advanced' as const,
      confidenceBefore: 0.1,
      confidenceAfter: 0.5,
      avoidedCost: 10,
      outcomeId,
      actor: { kind: 'system' as const, label: 'aurum-cognition' },
    });

    // B's impact cannot cite A's learning outcome — uniformly with a
    // missing one.
    await expectUniformNotFound(
      'invalid_outcome_ref',
      () => recordImpact(ctxB, impactInput(outcomeA.id)),
      () => recordImpact(ctxB, impactInput(newId())),
    );
    const viewB = await getContribution(ctxB, contributionB.id);
    expect(viewB.impact).toBeNull();

    // The omnipotent principal of B cannot read A's contribution.
    const planA = await seedAnsweredAsk(ctxA, 'Edsger Dijkstra');
    const contributionA = await recordContribution(ctxA, {
      planId: planA.id,
      summary: 'Alpha contribution for the authority probe.',
      actor: { kind: 'system', label: 'aurum-cognition' },
    });
    await expect(
      getContribution(omnipotent(tenantB), contributionA.id),
    ).rejects.toMatchObject({ code: 'contribution_not_found' });
  });
});

// ---------------------------------------------------------------------------
// environment (W014)
// ---------------------------------------------------------------------------

describe('W044 environment — watch programmes are tenant-scoped', () => {
  it('keeps watchlists, entries, signals and escalations per-tenant with uniform not-found', async () => {
    // The SAME watchlist name and entry name coexist in both tenants — the
    // per-tenant natural-key namespaces of migration 001.
    const listA = await createWatchlist(ctxA, {
      name: 'Competitive Landscape',
      description: 'W044 fixture',
      escalationPolicy: watchPolicy(),
    });
    const listB = await createWatchlist(ctxB, {
      name: 'Competitive Landscape',
      description: 'W044 fixture',
      escalationPolicy: watchPolicy(),
    });
    expect(listA.tenantId).toBe(tenantA);
    expect(listB.tenantId).toBe(tenantB);

    const entryInput = (watchlistId: string) => ({
      watchlistId,
      kind: 'entity' as const,
      entityKind: 'competitor' as const,
      name: 'Acme Corp',
      topics: ['pricing'],
    });
    const entryA = await addWatchEntry(ctxA, entryInput(listA.id));
    const entryB = await addWatchEntry(ctxB, entryInput(listB.id));

    // A duplicate entry identity collides only within its own tenant.
    await expect(addWatchEntry(ctxB, entryInput(listB.id))).rejects.toMatchObject({
      code: 'watch_entry_conflict',
    });

    // Severity 'high' meets the floor 'low': the signal arm fires an
    // escalation in the recording tenant only.
    const observationA = await recordObservation(ctxA, observationInput('alpha-watch'));
    const observationB = await recordObservation(ctxB, observationInput('beta-watch'));
    const hitA = await recordWatchSignal(ctxA, {
      watchEntryId: entryA.id,
      observationId: observationA.id,
      severity: 'high',
      note: 'W044 fixture',
    });
    const hitB = await recordWatchSignal(ctxB, {
      watchEntryId: entryB.id,
      observationId: observationB.id,
      severity: 'high',
      note: 'W044 fixture',
    });
    expect(hitA.escalation).not.toBeNull();
    expect(hitB.escalation).not.toBeNull();

    await expectUniformNotFound(
      'watchlist_not_found',
      () => getWatchlist(ctxB, { watchlistId: listA.id }),
      () => getWatchlist(ctxB, { watchlistId: newId() }),
    );
    await expectUniformNotFound(
      'watch_entry_not_found',
      () => getWatchEntry(ctxB, { watchEntryId: entryA.id }),
      () => getWatchEntry(ctxB, { watchEntryId: newId() }),
    );
    await expectUniformNotFound(
      'watch_signal_not_found',
      () => getWatchSignal(ctxB, { watchSignalId: hitA.signal.id }),
      () => getWatchSignal(ctxB, { watchSignalId: newId() }),
    );
    await expectUniformNotFound(
      'watch_escalation_not_found',
      () => getWatchEscalation(ctxB, { watchEscalationId: hitA.escalation!.id }),
      () => getWatchEscalation(ctxB, { watchEscalationId: newId() }),
    );

    expect((await listWatchlists(ctxB, {})).map((watchlist) => watchlist.id)).toContain(listB.id);
    expect((await listWatchlists(ctxB, {})).map((watchlist) => watchlist.id)).not.toContain(listA.id);
    expect((await listWatchEntries(ctxB, {})).map((entry) => entry.id)).not.toContain(entryA.id);
    expect(await listWatchEntries(ctxB, { watchlistId: listA.id })).toEqual([]);
    expect((await listWatchSignals(ctxB, {})).map((signal) => signal.id)).not.toContain(hitA.signal.id);
    expect(
      (await listWatchEscalations(ctxB, {})).map((escalation) => escalation.id),
    ).not.toContain(hitA.escalation!.id);
  });

  it('rejects cross-tenant watch writes before any mutation', async () => {
    const listA = await createWatchlist(ctxA, { name: 'EU Regulatory Watch', escalationPolicy: watchPolicy() });
    const entryA = await addWatchEntry(ctxA, {
      watchlistId: listA.id,
      kind: 'topic',
      name: 'AI regulation',
    });
    const observationB = await recordObservation(ctxB, observationInput('beta-foreign-write'));

    await expect(
      updateWatchlist(ctxB, { watchlistId: listA.id, name: 'Pwned by B' }),
    ).rejects.toMatchObject({ code: 'watchlist_not_found' });
    await expect(
      setWatchlistStatus(ctxB, { watchlistId: listA.id, status: 'archived' }),
    ).rejects.toMatchObject({ code: 'watchlist_not_found' });
    await expect(
      addWatchEntry(ctxB, { watchlistId: listA.id, kind: 'topic', name: 'Pwned topic' }),
    ).rejects.toMatchObject({ code: 'watchlist_not_found' });
    await expect(
      updateWatchEntry(ctxB, { watchEntryId: entryA.id, name: 'Pwned by B' }),
    ).rejects.toMatchObject({ code: 'watch_entry_not_found' });
    await expect(
      setWatchEntryStatus(ctxB, { watchEntryId: entryA.id, status: 'paused' }),
    ).rejects.toMatchObject({ code: 'watch_entry_not_found' });
    await expect(
      recordWatchSignal(ctxB, {
        watchEntryId: entryA.id,
        observationId: observationB.id,
        severity: 'critical',
      }),
    ).rejects.toMatchObject({ code: 'watch_entry_not_found' });

    // A's programme is unchanged: control content, lifecycle and feeds.
    const stillList = await getWatchlist(ctxA, { watchlistId: listA.id });
    expect(stillList.name).toBe('EU Regulatory Watch');
    expect(stillList.status).toBe('active');
    const stillEntry = await getWatchEntry(ctxA, { watchEntryId: entryA.id });
    expect(stillEntry.name).toBe('AI regulation');
    expect(stillEntry.status).toBe('active');
    expect(await listWatchSignals(ctxA, { watchEntryId: entryA.id })).toEqual([]);
    expect(await listWatchEscalations(ctxA, { watchlistId: listA.id })).toEqual([]);
  });

  it('rejects foreign world and observation references, and authority claims never widen scope', async () => {
    const competitorA = await createEntity(ctxA, { kind: 'competitor', name: 'Acme Corp' });
    const listB = await createWatchlist(ctxB, { name: 'W044 ref guard', escalationPolicy: watchPolicy() });
    const entryB = await addWatchEntry(ctxB, {
      watchlistId: listB.id,
      kind: 'topic',
      name: 'W044 beta topic',
    });

    // B cannot bind a watch entry to A's world entity — on add or update.
    await expect(
      addWatchEntry(ctxB, {
        watchlistId: listB.id,
        kind: 'entity',
        entityKind: 'competitor',
        name: 'Bound to A entity',
        worldEntityId: competitorA.id,
      }),
    ).rejects.toMatchObject({ code: 'invalid_world_ref' });
    await expect(
      updateWatchEntry(ctxB, { watchEntryId: entryB.id, worldEntityId: competitorA.id }),
    ).rejects.toMatchObject({ code: 'invalid_world_ref' });
    expect((await getWatchEntry(ctxB, { watchEntryId: entryB.id })).worldEntityId).toBeNull();

    // A's entry cannot collect a signal backed by B's observation.
    const listA = await createWatchlist(ctxA, { name: 'W044 ref guard A', escalationPolicy: watchPolicy() });
    const entryA = await addWatchEntry(ctxA, {
      watchlistId: listA.id,
      kind: 'topic',
      name: 'W044 alpha topic',
    });
    const observationB = await recordObservation(ctxB, observationInput('beta-foreign-obs'));
    await expect(
      recordWatchSignal(ctxA, {
        watchEntryId: entryA.id,
        observationId: observationB.id,
        severity: 'low',
      }),
    ).rejects.toMatchObject({ code: 'invalid_observation_ref' });

    // Freshness evaluation of a foreign entry reads as missing too.
    await expect(
      evaluateWatchFreshness(ctxB, { watchEntryId: entryA.id }),
    ).rejects.toMatchObject({ code: 'watch_entry_not_found' });

    // The omnipotent principal of B stays blind to A's programme.
    await expect(
      getWatchlist(omnipotent(tenantB), { watchlistId: listA.id }),
    ).rejects.toMatchObject({ code: 'watchlist_not_found' });
    await expect(
      getWatchEntry(omnipotent(tenantB), { watchEntryId: entryA.id }),
    ).rejects.toMatchObject({ code: 'watch_entry_not_found' });
  });
});

// ---------------------------------------------------------------------------
// outcomes (W054)
// ---------------------------------------------------------------------------

describe('W044 outcomes — intervention learning is tenant-scoped', () => {
  it('records the same intervention key independently per tenant with uniform not-found', async () => {
    const outcomeA = await defineOutcome(ctxA, outcomeFixture());
    const outcomeB = await defineOutcome(ctxB, outcomeFixture());
    const interventionInput = (outcomeId: string) => ({
      kind: 'train_employee' as const,
      capabilityLabel: 'Customer onboarding',
      target: { kind: 'person', label: 'W044 onboarding cohort' },
      outcomeId,
      actor: { kind: 'person' as const, id: newId() },
      rationale: 'W044 fixture',
    });

    const interventionA = await recordIntervention(ctxA, interventionInput(outcomeA.id));
    const interventionB = await recordIntervention(ctxB, interventionInput(outcomeB.id));
    expect(interventionA.tenantId).toBe(tenantA);
    expect(interventionB.tenantId).toBe(tenantB);
    expect(interventionA.capabilityKey).toBe(interventionB.capabilityKey);
    expect(interventionA.metric.expected).toBe(7);

    // The 1:1 measuring tie is a per-tenant namespace: a second
    // intervention on the same outcome collides in A only.
    await expect(
      recordIntervention(ctxA, {
        ...interventionInput(outcomeA.id),
        capabilityLabel: 'Duplicate on A outcome',
      }),
    ).rejects.toMatchObject({ code: 'intervention_conflict' });

    await expectUniformNotFound(
      'intervention_not_found',
      () => getIntervention(ctxB, interventionA.id),
      () => getIntervention(ctxB, newId()),
    );

    const inA = await listInterventions(ctxA, {});
    const inB = await listInterventions(ctxB, {});
    expect(inA.map((intervention) => intervention.id)).toContain(interventionA.id);
    expect(inA.map((intervention) => intervention.id)).not.toContain(interventionB.id);
    expect(inB.map((intervention) => intervention.id)).toContain(interventionB.id);
    expect(inB.map((intervention) => intervention.id)).not.toContain(interventionA.id);
    // The foreign measuring-outcome filter leaks nothing.
    expect(await listInterventions(ctxB, { outcomeId: outcomeA.id })).toEqual([]);
    expect(
      (await listInterventions(ctxB, { interventionKind: 'train_employee' }))
        .map((intervention) => intervention.id),
    ).toContain(interventionB.id);
  });

  it('rejects cross-tenant realization, abandonment and outcome links uniformly', async () => {
    const outcomeA = await defineOutcome(ctxA, outcomeFixture());
    const interventionA = await recordIntervention(ctxA, {
      kind: 'install_extension',
      capabilityLabel: 'Invoice matching',
      target: { kind: 'extension', label: 'invoice-matcher' },
      outcomeId: outcomeA.id,
      actor: { kind: 'person', id: newId() },
      rationale: 'W044 fixture',
    });
    const actor = { kind: 'person' as const, id: newId() };

    await expect(
      realizeIntervention(ctxB, { interventionId: interventionA.id, actor }),
    ).rejects.toMatchObject({ code: 'intervention_not_found' });
    await expect(
      abandonIntervention(ctxB, {
        interventionId: interventionA.id,
        reason: 'cross-tenant pwn',
        actor,
      }),
    ).rejects.toMatchObject({ code: 'intervention_not_found' });

    // A's intervention is untouched: still active, unmeasured, un-abandoned.
    const still = await getIntervention(ctxA, interventionA.id);
    expect(still.status).toBe('active');
    expect(still.realization).toBeNull();
    expect(still.abandonment).toBeNull();

    // B cannot tie an intervention to A's outcome — uniformly with a
    // missing one.
    await expectUniformNotFound(
      'invalid_outcome_ref',
      () => recordIntervention(ctxB, {
        kind: 'install_extension',
        capabilityLabel: 'B on A outcome',
        target: { kind: 'extension', label: 'invoice-matcher' },
        outcomeId: outcomeA.id,
        actor,
      }),
      () => recordIntervention(ctxB, {
        kind: 'install_extension',
        capabilityLabel: 'B on missing outcome',
        target: { kind: 'extension', label: 'invoice-matcher' },
        outcomeId: newId(),
        actor,
      }),
    );
    expect(
      (await listInterventions(ctxB, {})).map((intervention) => intervention.outcomeId),
    ).not.toContain(outcomeA.id);
  });

  it('learns intervention priors per tenant only, with independent version namespaces', async () => {
    const measureAndSettle = async (ctx: TenantContext, outcomeId: string) => {
      const measurement = await recordMeasurement(ctx, {
        outcomeId,
        value: 9,
        actor: { kind: 'system', label: 'onboarding-report' },
      });
      await settleOutcome(ctx, {
        outcomeId,
        measurementId: measurement.id,
        actor: { kind: 'person', id: newId() },
      });
    };

    const outcomeA = await defineOutcome(ctxA, outcomeFixture());
    const outcomeB = await defineOutcome(ctxB, outcomeFixture());
    const interventionInput = (outcomeId: string) => ({
      kind: 'train_employee' as const,
      capabilityLabel: 'Customer onboarding',
      target: { kind: 'person', label: 'W044 onboarding cohort' },
      outcomeId,
      actor: { kind: 'person' as const, id: newId() },
      rationale: 'W044 fixture',
    });
    const interventionA = await recordIntervention(ctxA, interventionInput(outcomeA.id));
    const interventionB = await recordIntervention(ctxB, interventionInput(outcomeB.id));
    await measureAndSettle(ctxA, outcomeA.id);
    await measureAndSettle(ctxB, outcomeB.id);

    const realizedA = await realizeIntervention(ctxA, {
      interventionId: interventionA.id,
      actor: { kind: 'person', id: newId() },
    });
    const realizedB = await realizeIntervention(ctxB, {
      interventionId: interventionB.id,
      actor: { kind: 'person', id: newId() },
    });
    expect(realizedA.status).toBe('realized');
    expect(realizedB.status).toBe('realized');
    expect(realizedA.realization?.polarity).toBe('positive');

    // The SAME (kind, capability key) learns independently per tenant: both
    // are on version 1 with one sample each — never each other's evidence.
    const kind = 'train_employee' as const;
    const capabilityKey = realizedA.capabilityKey;
    const priorsA = await getInterventionPriors(ctxA, { interventionKind: kind, capabilityKey });
    const priorsB = await getInterventionPriors(ctxB, { interventionKind: kind, capabilityKey });
    expect(priorsA).toHaveLength(1);
    expect(priorsB).toHaveLength(1);
    expect(priorsA[0]!.priorVersion).toBe(1);
    expect(priorsB[0]!.priorVersion).toBe(1);
    expect(priorsA[0]!.sampleSize).toBe(1);
    expect(priorsB[0]!.sampleSize).toBe(1);
    expect(priorsA[0]!.evidenceInterventionIds).toEqual([interventionA.id]);
    expect(priorsB[0]!.evidenceInterventionIds).toEqual([interventionB.id]);
    expect(priorsA[0]!.id).not.toBe(priorsB[0]!.id);
    expect(
      await listInterventionPriorVersions(ctxB, { interventionKind: kind, capabilityKey }),
    ).toHaveLength(1);

    // The omnipotent principal of B cannot read A's intervention.
    await expect(
      getIntervention(omnipotent(tenantB), interventionA.id),
    ).rejects.toMatchObject({ code: 'intervention_not_found' });
  });
});

// ---------------------------------------------------------------------------
// quality (W055)
// ---------------------------------------------------------------------------

describe('W044 quality — judgments and snapshots are tenant-scoped', () => {
  it('keeps judgments and computed snapshots per-tenant with uniform not-found', async () => {
    // The same gapKey carries DIFFERENT ground truth per tenant — the
    // judgment namespace is per-tenant.
    const gapKey = 'w044-quality|shared-gap';
    const judgmentA = await recordJudgment(ctxA, {
      kind: 'unknown-consequentiality',
      gapKey,
      verdict: 'consequential',
      evaluator: { kind: 'person', label: 'Alpha evaluator' },
      note: 'W044 fixture',
    });
    const judgmentB = await recordJudgment(ctxB, {
      kind: 'unknown-consequentiality',
      gapKey,
      verdict: 'not_consequential',
      evaluator: { kind: 'person', label: 'Beta evaluator' },
      note: 'W044 fixture',
    });
    expect(judgmentA.tenantId).toBe(tenantA);
    expect(judgmentB.tenantId).toBe(tenantB);

    // Source-selection judgments on each tenant's own plan.
    const planA = await seedSystemPlan(ctxA);
    const planB = await seedSystemPlan(ctxB);
    const selectionA = await recordJudgment(ctxA, {
      kind: 'source-selection',
      planId: planA.id,
      verdict: 'correct',
      evaluator: { kind: 'person', label: 'Alpha evaluator' },
    });
    const selectionB = await recordJudgment(ctxB, {
      kind: 'source-selection',
      planId: planB.id,
      verdict: 'incorrect',
      evaluator: { kind: 'person', label: 'Beta evaluator' },
    });

    // Same-window snapshots computed in both tenants.
    const snapshotInput = () => ({
      windowFrom: '2020-01-01T00:00:00.000Z',
      windowTo: '2030-01-01T00:00:00.000Z',
      metricKinds: ['unknown-discovery' as const],
      actor: { kind: 'system' as const, label: 'aurum-quality' },
      rationale: 'W044 fixture',
    });
    const snapshotA = await computeQualitySnapshot(ctxA, snapshotInput());
    const snapshotB = await computeQualitySnapshot(ctxB, snapshotInput());

    await expectUniformNotFound(
      'judgment_not_found',
      () => getJudgment(ctxB, { judgmentId: judgmentA.id }),
      () => getJudgment(ctxB, { judgmentId: newId() }),
    );
    await expectUniformNotFound(
      'snapshot_not_found',
      () => getQualitySnapshot(ctxB, { snapshotId: snapshotA.id }),
      () => getQualitySnapshot(ctxB, { snapshotId: newId() }),
    );

    // Per-tenant gap resolution: same key, different verdicts, no bleed.
    const aFeed = await listJudgments(ctxA, { gapKey });
    const bFeed = await listJudgments(ctxB, { gapKey });
    expect(aFeed.map((judgment) => judgment.id)).toEqual([judgmentA.id]);
    expect(bFeed.map((judgment) => judgment.id)).toEqual([judgmentB.id]);
    expect(aFeed[0]!.verdict).toBe('consequential');
    expect(bFeed[0]!.verdict).toBe('not_consequential');
    expect(await listJudgments(ctxB, { planId: planA.id })).toEqual([]);
    expect(await listJudgments(ctxA, { planId: planB.id })).toEqual([]);
    expect((await listJudgments(ctxA, { planId: planA.id })).map((judgment) => judgment.id)).toEqual([
      selectionA.id,
    ]);
    expect((await listJudgments(ctxB, { planId: planB.id })).map((judgment) => judgment.id)).toEqual([
      selectionB.id,
    ]);

    const snapshotsInB = await listQualitySnapshots(ctxB, {});
    expect(snapshotsInB.map((snapshot) => snapshot.id)).toContain(snapshotB.id);
    expect(snapshotsInB.map((snapshot) => snapshot.id)).not.toContain(snapshotA.id);

    // The computed surface partitions with the tenant: A's ground truth
    // includes its own consequential gap; B's never sees A's label (its own
    // judgment on the shared key is 'not_consequential').
    const fullA = await getQualitySnapshot(ctxA, { snapshotId: snapshotA.id });
    const fullB = await getQualitySnapshot(ctxB, { snapshotId: snapshotB.id });
    expect(fullA.inputs.judgmentsConsidered).toBeGreaterThanOrEqual(2);
    expect(fullB.inputs.judgmentsConsidered).toBeGreaterThanOrEqual(2);
    const discoveryA = fullA.results.find((result) => result.metricKind === 'unknown-discovery')!;
    const discoveryB = fullB.results.find((result) => result.metricKind === 'unknown-discovery')!;
    expect((discoveryA.payload as UnknownDiscoveryPayload).groundTruthConsequential).toBeGreaterThanOrEqual(1);
    expect((discoveryB.payload as UnknownDiscoveryPayload).groundTruthConsequential).toBe(0);
  });

  it('rejects foreign plan, candidate and execution references, and authority claims never widen scope', async () => {
    // A's discovery candidate (the attention fixture shape) for the ref probe.
    const goal = await createGoal(ctxA, {
      title: 'W044 quality discovery goal',
      objective: 'Guard cross-tenant judgment references',
      desiredState: 'No foreign references accepted',
      metrics: [{ name: 'w044-quality-ratio', unit: 'ratio', direction: 'at_most', threshold: 0.1 }],
      horizonEnd: FAR_HORIZON,
      owner: { kind: 'person', id: PERSON_ID, label: 'COO' },
      priority: 'high',
      evidenceSources: [],
      successCriteria: 'Every foreign reference rejected',
      actor: { kind: 'person', id: PERSON_ID },
      rationale: 'W044 fixture',
    });
    const observation = await recordObservation(ctxA, {
      kind: 'metric.sample',
      payload: { metric: 'w044-quality-ratio', value: 8.4 },
      observedAt: T0,
      source: { kind: 'source', label: 'alpha-crm' },
      channel: 'ingestion',
      confidence: { value: 0.85, method: 'source_trust' },
    });
    const claim = await recordClaim(ctxA, {
      proposition: 'W044 quality ratio is 8.4',
      subject: { kind: 'goals.goal', id: goal.id },
      confidence: { value: 0.85, method: 'source_trust', basis: 'fixture' },
      evidenceObservationIds: [observation.id],
      rationale: 'W044 fixture',
    });
    const run = await runGoalGapDiscovery(ctxA, {
      trigger: { kind: 'scheduled', label: 'W044 quality sweep' },
      readings: [
        { goalId: goal.id, metricName: 'w044-quality-ratio', value: 8.4, evidenceClaimIds: [claim.id] },
      ],
      proposals: [],
      investigationBudget: { amount: 100_00, currency: 'EUR' },
      rewardBudget: { amount: 50_00, currency: 'EUR' },
      actor: { kind: 'system', label: 'aurum-attention' },
      rationale: 'W044 fixture',
    });
    const candidate = (await getDiscoveryRun(ctxA, { runId: run.id })).candidates[0]!;

    // A's acquisition plan (W012) for the source-selection ref probe.
    const missionA = await createMission(ctxA, {
      title: 'W044 quality ref guard',
      knowledgeObjective: 'Which system explains the anomaly?',
      informationValue: 0.8,
      urgency: 'medium',
      currentConfidence: 0.1,
      targetConfidence: 0.8,
      investigationBudget: { amount: 100_00, currency: 'EUR' },
      rewardBudget: { amount: 20_00, currency: 'EUR' },
      candidateSources: [{ kind: 'system', label: 'billing-export' }],
      completionCriteria: 'The anomaly is explained with evidence.',
      actor: { kind: 'person', id: newId() },
      rationale: 'W044 fixture',
    });
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
      rationale: 'W044 fixture',
    });

    // B citing A's plan is uniformly indistinguishable from a missing one.
    await expectUniformNotFound(
      'invalid_plan_ref',
      () => recordJudgment(ctxB, {
        kind: 'source-selection',
        planId: planA.id,
        verdict: 'correct',
        evaluator: { kind: 'person', label: 'Beta evaluator' },
      }),
      () => recordJudgment(ctxB, {
        kind: 'source-selection',
        planId: newId(),
        verdict: 'correct',
        evaluator: { kind: 'person', label: 'Beta evaluator' },
      }),
    );
    // B cannot judge a candidate promoted in A.
    await expect(
      recordJudgment(ctxB, {
        kind: 'unknown-consequentiality',
        gapKey: 'w044-quality|foreign-candidate',
        candidateId: candidate.id,
        verdict: 'consequential',
        evaluator: { kind: 'person', label: 'Beta evaluator' },
      }),
    ).rejects.toMatchObject({ code: 'invalid_candidate_ref' });
    // B's snapshot cannot be attributed to A's cognition execution.
    const executionA = await startExecution(ctxA, {
      trigger: { kind: 'system', label: 'W044 quality origin' },
      focus: { topics: ['quality'], entities: [] },
      actor: { kind: 'system', label: 'aurum-cognition' },
      rationale: 'W044 fixture',
    });
    const snapshotsInBBefore = (await listQualitySnapshots(ctxB, {})).length;
    await expect(
      computeQualitySnapshot(ctxB, {
        windowFrom: '2020-01-01T00:00:00.000Z',
        windowTo: '2030-01-01T00:00:00.000Z',
        metricKinds: ['evidence-quality'],
        originExecutionId: executionA.id,
        actor: { kind: 'system', label: 'aurum-quality' },
      }),
    ).rejects.toMatchObject({ code: 'invalid_origin_ref' });
    expect(await listQualitySnapshots(ctxB, {})).toHaveLength(snapshotsInBBefore);

    // The omnipotent principal of B stays blind to A's judgments and
    // snapshots.
    const judgmentA = await recordJudgment(ctxA, {
      kind: 'unknown-consequentiality',
      gapKey: 'w044-quality|alpha-only',
      verdict: 'consequential',
      evaluator: { kind: 'person', label: 'Alpha evaluator' },
    });
    const snapshotA = await computeQualitySnapshot(ctxA, {
      windowFrom: '2020-01-01T00:00:00.000Z',
      windowTo: '2030-01-01T00:00:00.000Z',
      metricKinds: ['evidence-quality'],
      actor: { kind: 'system', label: 'aurum-quality' },
      rationale: 'W044 fixture',
    });
    await expect(getJudgment(omnipotent(tenantB), { judgmentId: judgmentA.id })).rejects.toMatchObject({
      code: 'judgment_not_found',
    });
    await expect(
      getQualitySnapshot(omnipotent(tenantB), { snapshotId: snapshotA.id }),
    ).rejects.toMatchObject({ code: 'snapshot_not_found' });
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
