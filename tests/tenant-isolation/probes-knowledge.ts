// W044 — Tenant Isolation Verification: probes for the knowledge-direction
// modules (memory, epistemics, freshness, goals, missions,
// knowledge-acquisition).
//
// Same protocol as probes-foundation.ts: two tenants seeded through public
// contracts only; the runner enforces the uniform read/list/write invariants
// documented in tests/tenant-isolation/harness.ts.

import { expect } from 'vitest';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
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
  formBelief,
  getBelief,
  getClaim,
  getContradiction,
  getHypothesis,
  getUnknown,
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
  retireBelief,
  reviseBelief,
} from '@/modules/epistemics/contract';
import {
  evaluateTemporalStateFreshness,
  getFreshnessPolicy,
  getTemporalState,
  listFreshnessPolicies,
  listTemporalHistory,
  recordTemporalRevision,
  setFreshnessPolicy,
} from '@/modules/freshness/contract';
import {
  createGoal,
  getGoal,
  getGoalVersion,
  listGoalVersions,
  listGoals,
  reviseGoal,
} from '@/modules/goals/contract';
import {
  abandonMission,
  completeMission,
  createMission,
  getMission,
  getMissionVersion,
  listMissionVersions,
  listMissions,
  reviseMission,
} from '@/modules/missions/contract';
import {
  getAcquisitionPlan,
  listAcquisitionPlans,
  planNextAcquisition,
  recordAcquisitionOutcome,
} from '@/modules/knowledge-acquisition/contract';
import {
  attestIdentity,
  IDENTITY_AUTHORITY_ATTEST,
  IDENTITY_AUTHORITY_LINK,
  registerExternalIdentity,
} from '@/modules/identity/contract';
import { createEmployee, createPerson, linkExternalIdentity } from '@/modules/people/contract';
import { member, seedEvidence, t0Plus, W044_T0, type ModuleProbe } from './harness';

/** Fixed opaque party id used by goal/mission fixtures (forward reference, unvalidated). */
const PARTY_ID = '0b2f8e2a-1c4b-4d8a-9f3e-7a2b6c5d4e8f';

// ---------------------------------------------------------------------------
// memory
// ---------------------------------------------------------------------------

const memoryProbe: ModuleProbe = {
  module: 'memory',
  setup: async () => {
    const tenantA = newId();
    const tenantB = newId();
    const ctxA = member(tenantA);
    const ctxB = member(tenantB);

    const knowledgeInput = (evidenceObservationIds: string[]) => ({
      kind: 'fact' as const,
      title: 'W044 fact',
      summary: 'W044 summary of the fact.',
      topics: ['w044-shared'],
      entities: [{ kind: 'customer', label: 'W044 Customer' }],
      evidenceObservationIds,
      notes: 'w044 harness',
    });
    const transactiveInput = (evidenceObservationIds: string[]) => ({
      actor: { kind: 'person' as const, id: newId(), label: 'w044-alice' },
      relation: 'knows' as const,
      subjectLabel: 'W044 HVAC contracts',
      topics: ['w044-shared'],
      entities: [{ kind: 'process', label: 'W044 facilities' }],
      evidenceObservationIds,
      notes: 'w044 harness',
    });

    const evidenceA = await seedEvidence(ctxA, 'memory A');
    const knowledgeA = await recordKnowledgeEntry(ctxA, knowledgeInput([evidenceA]));
    const transactiveA = await recordTransactiveEntry(ctxA, transactiveInput([evidenceA]));
    const evidenceB = await seedEvidence(ctxB, 'memory B');
    const knowledgeB = await recordKnowledgeEntry(ctxB, knowledgeInput([evidenceB]));
    const transactiveB = await recordTransactiveEntry(ctxB, transactiveInput([evidenceB]));

    const ids = {
      knowledge: knowledgeA.id,
      transactive: transactiveA.id,
      observation: evidenceA,
    };
    const idsB = { knowledge: knowledgeB.id, transactive: transactiveB.id, observation: evidenceB };
    const idKeys = ['knowledge', 'transactive', 'observation'];

    return {
      module: 'memory',
      ctxA,
      ctxB,
      ids,
      idsB,
      idKeys,
      contextProbe: (ctx) => getKnowledgeEntry(ctx, ids.knowledge!),
      reads: [
        {
          name: 'getKnowledgeEntry',
          code: 'knowledge_entry_not_found',
          run: (ctx, probeIds) => getKnowledgeEntry(ctx, probeIds.knowledge!),
        },
        {
          name: 'getTransactiveEntry',
          code: 'transactive_entry_not_found',
          run: (ctx, probeIds) => getTransactiveEntry(ctx, probeIds.transactive!),
        },
        {
          name: 'getKnowledgeEntryEvidence',
          code: 'knowledge_entry_not_found',
          run: (ctx, probeIds) => getKnowledgeEntryEvidence(ctx, probeIds.knowledge!),
        },
      ],
      lists: [
        {
          name: 'listKnowledgeEntries by shared topic',
          run: (ctx) => listKnowledgeEntries(ctx, { topics: ['w044-shared'] }),
        },
        {
          name: 'listKnowledgeEntries tracing another tenant\'s evidence',
          run: (ctx, probeIds) =>
            listKnowledgeEntries(ctx, { evidenceObservationId: probeIds.observation! }),
        },
        {
          name: 'listTransactiveEntries by shared topic',
          run: (ctx) => listTransactiveEntries(ctx, { topics: ['w044-shared'] }),
        },
      ],
      writes: [
        {
          name: 'recordKnowledgeEntry citing another tenant\'s evidence',
          code: 'invalid_provenance',
          run: (ctx, probeIds) => recordKnowledgeEntry(ctx, knowledgeInput([probeIds.observation!])),
        },
        {
          name: 'recordTransactiveEntry citing another tenant\'s evidence',
          code: 'invalid_provenance',
          run: (ctx, probeIds) =>
            recordTransactiveEntry(ctx, transactiveInput([probeIds.observation!])),
        },
      ],
      checks: [],
    };
  },
};

// ---------------------------------------------------------------------------
// epistemics
// ---------------------------------------------------------------------------

const epistemicsProbe: ModuleProbe = {
  module: 'epistemics',
  setup: async () => {
    const tenantA = newId();
    const tenantB = newId();
    const ctxA = member(tenantA);
    const ctxB = member(tenantB);

    const claimInput = (evidenceObservationIds: string[]) => ({
      proposition: 'W044 supplier delivers within five business days',
      subject: { kind: 'world.entity' as const, id: newId() },
      confidence: { value: 0.8, method: 'evidence_weighing', basis: 'w044' },
      evidenceObservationIds,
      rationale: 'w044 harness',
    });
    const beliefInput = (supportingObservationIds: string[], validFrom: string) => ({
      proposition: 'W044 supplier is reliable',
      confidence: { value: 0.7, method: 'evidence_weighing' },
      supportingObservationIds,
      alternatives: ['w044 alternative explanation'],
      disconfirmation: 'a late delivery observed after this quarter',
      subject: { kind: 'world.entity' as const, id: newId() },
      validFrom,
      rationale: 'w044 harness',
    });

    const evidenceA = await seedEvidence(ctxA, 'epistemics A');
    const claimA = await recordClaim(ctxA, claimInput([evidenceA]));
    const claimA2 = await recordClaim(ctxA, claimInput([evidenceA]));
    const contradictionA = await registerContradiction(ctxA, {
      left: { kind: 'claim', id: claimA.id },
      right: { kind: 'claim', id: claimA2.id },
      note: 'w044 contradiction',
    });
    const hypothesisA = await recordHypothesis(ctxA, {
      proposition: 'W044 hypothesis',
      subject: { kind: 'world.entity', id: newId() },
    });
    const beliefA = await formBelief(ctxA, beliefInput([evidenceA], W044_T0));
    const unknownA = await recordUnknown(ctxA, {
      question: 'W044 question?',
      consequence: 'W044 consequence',
    });

    const evidenceB = await seedEvidence(ctxB, 'epistemics B');
    const claimB = await recordClaim(ctxB, claimInput([evidenceB]));
    const claimB2 = await recordClaim(ctxB, claimInput([evidenceB]));
    const contradictionB = await registerContradiction(ctxB, {
      left: { kind: 'claim', id: claimB.id },
      right: { kind: 'claim', id: claimB2.id },
      note: 'w044 contradiction',
    });
    const hypothesisB = await recordHypothesis(ctxB, {
      proposition: 'W044 hypothesis',
      subject: { kind: 'world.entity', id: newId() },
    });
    const beliefB = await formBelief(ctxB, beliefInput([evidenceB], W044_T0));
    const unknownB = await recordUnknown(ctxB, {
      question: 'W044 question?',
      consequence: 'W044 consequence',
    });

    const ids = {
      claim: claimA.id,
      contradiction: contradictionA.id,
      hypothesis: hypothesisA.id,
      belief: beliefA.id,
      unknown: unknownA.id,
      observation: evidenceA,
    };
    const idsB = {
      claim: claimB.id,
      contradiction: contradictionB.id,
      hypothesis: hypothesisB.id,
      belief: beliefB.id,
      unknown: unknownB.id,
      observation: evidenceB,
    };
    const idKeys = ['claim', 'contradiction', 'hypothesis', 'belief', 'unknown', 'observation'];

    return {
      module: 'epistemics',
      ctxA,
      ctxB,
      ids,
      idsB,
      idKeys,
      contextProbe: (ctx) => getClaim(ctx, { claimId: ids.claim! }),
      reads: [
        {
          name: 'getClaim',
          code: 'claim_not_found',
          run: (ctx, probeIds) => getClaim(ctx, { claimId: probeIds.claim! }),
        },
        {
          name: 'getContradiction',
          code: 'contradiction_not_found',
          run: (ctx, probeIds) => getContradiction(ctx, { contradictionId: probeIds.contradiction! }),
        },
        {
          name: 'getHypothesis',
          code: 'hypothesis_not_found',
          run: (ctx, probeIds) => getHypothesis(ctx, { hypothesisId: probeIds.hypothesis! }),
        },
        {
          name: 'getUnknown',
          code: 'unknown_not_found',
          run: (ctx, probeIds) => getUnknown(ctx, { unknownId: probeIds.unknown! }),
        },
        {
          name: 'getBelief',
          code: 'belief_not_found',
          run: (ctx, probeIds) => getBelief(ctx, { beliefId: probeIds.belief!, asOf: t0Plus(3600) }),
        },
        {
          name: 'listBeliefHistory',
          code: 'belief_not_found',
          run: (ctx, probeIds) => listBeliefHistory(ctx, { beliefId: probeIds.belief! }),
        },
      ],
      lists: [
        { name: 'listClaims', run: (ctx) => listClaims(ctx, {}) },
        { name: 'listContradictions', run: (ctx) => listContradictions(ctx, {}) },
        { name: 'listHypotheses', run: (ctx) => listHypotheses(ctx, {}) },
        { name: 'listUnknowns', run: (ctx) => listUnknowns(ctx, {}) },
        { name: 'listBeliefs', run: (ctx) => listBeliefs(ctx, {}) },
      ],
      writes: [
        {
          name: 'recordClaim citing another tenant\'s evidence',
          code: 'invalid_evidence',
          run: (ctx, probeIds) => recordClaim(ctx, claimInput([probeIds.observation!])),
        },
        {
          name: 'formBelief citing another tenant\'s evidence',
          code: 'invalid_evidence',
          run: (ctx, probeIds) => formBelief(ctx, beliefInput([probeIds.observation!], t0Plus(7200))),
        },
        {
          name: 'registerContradiction over another tenant\'s records',
          code: 'invalid_evidence',
          run: (ctx, probeIds) =>
            registerContradiction(ctx, {
              left: { kind: 'claim', id: probeIds.claim! },
              right: { kind: 'observation', id: probeIds.observation! },
              note: 'w044 cross-tenant',
            }),
        },
        {
          name: 'resolveContradiction',
          code: 'contradiction_not_found',
          run: (ctx, probeIds) =>
            resolveContradiction(ctx, { contradictionId: probeIds.contradiction!, note: 'w044' }),
        },
        {
          name: 'resolveHypothesis',
          code: 'hypothesis_not_found',
          run: (ctx, probeIds) =>
            resolveHypothesis(ctx, {
              hypothesisId: probeIds.hypothesis!,
              outcome: 'confirmed',
              note: 'w044',
            }),
        },
        {
          name: 'resolveUnknown',
          code: 'unknown_not_found',
          run: (ctx, probeIds) => resolveUnknown(ctx, { unknownId: probeIds.unknown!, note: 'w044' }),
        },
        {
          name: 'retireBelief',
          code: 'belief_not_found',
          run: (ctx, probeIds) =>
            retireBelief(ctx, { beliefId: probeIds.belief!, rationale: 'w044' }),
        },
        {
          name: 'reviseBelief',
          code: 'belief_not_found',
          run: (ctx, probeIds) =>
            reviseBelief(ctx, {
              ...beliefInput([probeIds.observation!], t0Plus(7200)),
              beliefId: probeIds.belief!,
            }),
        },
      ],
      checks: [],
    };
  },
};

// ---------------------------------------------------------------------------
// freshness
// ---------------------------------------------------------------------------

const freshnessProbe: ModuleProbe = {
  module: 'freshness',
  setup: async () => {
    const tenantA = newId();
    const tenantB = newId();
    const ctxA = member(tenantA);
    const ctxB = member(tenantB);
    const subjectKind = 'world.relationship';

    const evidenceA = await seedEvidence(ctxA, 'freshness A');
    const evidenceB = await seedEvidence(ctxB, 'freshness B');

    // tenant-A-only chain and policy (the uniform not-found probe targets)
    const subjectA = newId();
    const revisionA = await recordTemporalRevision(ctxA, {
      subjectKind,
      subjectId: subjectA,
      state: { strength: 'strong' },
      validFrom: W044_T0,
      observationIds: [evidenceA],
      rationale: 'w044 initial',
    });
    const policySubjectA = newId();
    const policyA = await setFreshnessPolicy(ctxA, {
      subjectKind: 'source',
      subjectId: policySubjectA,
      staleAfterSeconds: 3600,
      agingAfterSeconds: 600,
      note: 'w044 A',
    });

    // tenant-B-only chain and policy
    const subjectB = newId();
    const revisionB = await recordTemporalRevision(ctxB, {
      subjectKind,
      subjectId: subjectB,
      state: { strength: 'weak' },
      validFrom: W044_T0,
      observationIds: [evidenceB],
      rationale: 'w044 initial',
    });
    const policySubjectB = newId();
    const policyB = await setFreshnessPolicy(ctxB, {
      subjectKind: 'source',
      subjectId: policySubjectB,
      staleAfterSeconds: 86400,
      agingAfterSeconds: 600,
      note: 'w044 B',
    });

    // the SAME subject keys written by BOTH tenants — independent chains/policies
    const sharedSubject = newId();
    await recordTemporalRevision(ctxA, {
      subjectKind,
      subjectId: sharedSubject,
      state: { owner: 'alpha' },
      validFrom: t0Plus(3600),
      observationIds: [evidenceA],
      rationale: 'w044 shared key, tenant A',
    });
    await recordTemporalRevision(ctxB, {
      subjectKind,
      subjectId: sharedSubject,
      state: { owner: 'beta' },
      validFrom: t0Plus(3600),
      observationIds: [evidenceB],
      rationale: 'w044 shared key, tenant B',
    });
    const sharedPolicySubject = newId();
    await setFreshnessPolicy(ctxA, {
      subjectKind: 'source',
      subjectId: sharedPolicySubject,
      staleAfterSeconds: 7200,
      agingAfterSeconds: 600,
    });
    await setFreshnessPolicy(ctxB, {
      subjectKind: 'source',
      subjectId: sharedPolicySubject,
      staleAfterSeconds: 120,
      agingAfterSeconds: 60,
    });

    const ids = {
      subject: subjectA,
      revision: revisionA.id,
      policySubject: policySubjectA,
      policy: policyA.id,
      observation: evidenceA,
    };
    const idsB = {
      subject: subjectB,
      revision: revisionB.id,
      policySubject: policySubjectB,
      policy: policyB.id,
      observation: evidenceB,
    };
    const idKeys = ['subject', 'revision', 'policySubject', 'policy', 'observation'];

    return {
      module: 'freshness',
      ctxA,
      ctxB,
      ids,
      idsB,
      idKeys,
      contextProbe: (ctx) =>
        getTemporalState(ctx, { subjectKind, subjectId: ids.subject!, asOf: t0Plus(3600) }),
      reads: [
        {
          name: 'getTemporalState',
          code: 'temporal_state_not_found',
          run: (ctx, probeIds) =>
            getTemporalState(ctx, { subjectKind, subjectId: probeIds.subject!, asOf: t0Plus(3600) }),
        },
        {
          name: 'evaluateTemporalStateFreshness',
          code: 'temporal_state_not_found',
          run: (ctx, probeIds) =>
            evaluateTemporalStateFreshness(ctx, {
              subjectKind,
              subjectId: probeIds.subject!,
              asOf: t0Plus(3600),
            }),
        },
        {
          name: 'getFreshnessPolicy',
          code: 'policy_not_found',
          run: (ctx, probeIds) =>
            getFreshnessPolicy(ctx, { subjectKind: 'source', subjectId: probeIds.policySubject! }),
        },
      ],
      lists: [
        {
          name: 'listTemporalHistory',
          run: (ctx, probeIds) =>
            listTemporalHistory(ctx, { subjectKind, subjectId: probeIds.subject! }),
        },
        { name: 'listFreshnessPolicies', run: (ctx) => listFreshnessPolicies(ctx, {}) },
      ],
      writes: [
        {
          name: 'recordTemporalRevision citing another tenant\'s evidence',
          code: 'invalid_provenance',
          run: (ctx, probeIds) =>
            recordTemporalRevision(ctx, {
              subjectKind,
              subjectId: probeIds.subject!,
              state: { hijack: true },
              validFrom: t0Plus(3600),
              observationIds: [probeIds.observation!],
              rationale: 'w044 cross-tenant',
            }),
        },
      ],
      checks: [
        {
          name: 'the same subject key holds independent per-tenant chains and policies',
          run: async () => {
            const stateA = await getTemporalState(ctxA, {
              subjectKind,
              subjectId: sharedSubject,
              asOf: t0Plus(7200),
            });
            const stateB = await getTemporalState(ctxB, {
              subjectKind,
              subjectId: sharedSubject,
              asOf: t0Plus(7200),
            });
            expect(stateA.state).toEqual({ owner: 'alpha' });
            expect(stateB.state).toEqual({ owner: 'beta' });
            const policyAtSharedA = await getFreshnessPolicy(ctxA, {
              subjectKind: 'source',
              subjectId: sharedPolicySubject,
            });
            const policyAtSharedB = await getFreshnessPolicy(ctxB, {
              subjectKind: 'source',
              subjectId: sharedPolicySubject,
            });
            expect(policyAtSharedA.staleAfterSeconds).toBe(7200);
            expect(policyAtSharedB.staleAfterSeconds).toBe(120);
          },
        },
      ],
    };
  },
};

// ---------------------------------------------------------------------------
// goals
// ---------------------------------------------------------------------------

const goalsProbe: ModuleProbe = {
  module: 'goals',
  setup: async () => {
    const tenantA = newId();
    const tenantB = newId();
    const ctxA = member(tenantA);
    const ctxB = member(tenantB);

    const goalInput = () => ({
      title: 'W044 Goal',
      objective: 'W044 objective.',
      desiredState: 'W044 desired state.',
      metrics: [
        { name: 'w044-metric', unit: 'ratio', direction: 'at_most' as const, threshold: 0.05 },
      ],
      horizonStart: W044_T0,
      horizonEnd: '2026-12-01T00:00:00.000Z',
      owner: { kind: 'person' as const, id: PARTY_ID, label: 'W044 Owner' },
      priority: 'high' as const,
      evidenceSources: [{ kind: 'source' as const, label: 'w044-export' }],
      successCriteria: 'W044 success criteria.',
      actor: { kind: 'person' as const, id: PARTY_ID },
      rationale: 'w044',
    });

    const goalA = await createGoal(ctxA, goalInput());
    await reviseGoal(ctxA, {
      goalId: goalA.id,
      title: 'W044 Goal (v2)',
      actor: { kind: 'person', id: PARTY_ID },
      rationale: 'w044 revision',
    });
    const goalB = await createGoal(ctxB, goalInput());

    const ids = { goal: goalA.id };
    const idsB = { goal: goalB.id };
    const idKeys = ['goal'];

    return {
      module: 'goals',
      ctxA,
      ctxB,
      ids,
      idsB,
      idKeys,
      contextProbe: (ctx) => getGoal(ctx, ids.goal!),
      reads: [
        {
          name: 'getGoal',
          code: 'goal_not_found',
          run: (ctx, probeIds) => getGoal(ctx, probeIds.goal!),
        },
        {
          name: 'getGoalVersion',
          code: 'goal_version_not_found',
          run: (ctx, probeIds) => getGoalVersion(ctx, { goalId: probeIds.goal!, version: 1 }),
        },
        {
          name: 'listGoalVersions',
          code: 'goal_not_found',
          run: (ctx, probeIds) => listGoalVersions(ctx, { goalId: probeIds.goal! }),
        },
      ],
      lists: [
        { name: 'listGoals', run: (ctx) => listGoals(ctx, {}) },
        { name: 'listGoals by shared title', run: (ctx) => listGoals(ctx, { search: 'W044 Goal' }) },
      ],
      writes: [
        {
          name: 'reviseGoal',
          code: 'goal_not_found',
          run: (ctx, probeIds) =>
            reviseGoal(ctx, {
              goalId: probeIds.goal!,
              title: 'w044 hijack',
              actor: { kind: 'person', id: PARTY_ID },
              rationale: 'w044 cross-tenant',
            }),
        },
      ],
      checks: [],
    };
  },
};

// ---------------------------------------------------------------------------
// missions
// ---------------------------------------------------------------------------

const missionsProbe: ModuleProbe = {
  module: 'missions',
  setup: async () => {
    const tenantA = newId();
    const tenantB = newId();
    const ctxA = member(tenantA);
    const ctxB = member(tenantB);

    const missionInput = (unknownIds: string[]) => ({
      title: 'W044 Mission',
      knowledgeObjective: 'W044 knowledge objective?',
      affectedGoals: [],
      unknownIds,
      informationValue: 0.8,
      urgency: 'high' as const,
      currentConfidence: 0.1,
      targetConfidence: 0.85,
      investigationBudget: { amount: 250_00, currency: 'EUR' },
      rewardBudget: { amount: 50_00, currency: 'EUR' },
      rewardTerms: null,
      candidateSources: [],
      completionCriteria: 'W044 completion criteria.',
      actor: { kind: 'person' as const, label: 'COO' },
      rationale: 'w044',
    });

    const unknownA = await recordUnknown(ctxA, {
      question: 'W044 question?',
      consequence: 'W044 consequence',
    });
    const missionA = await createMission(ctxA, missionInput([unknownA.id]));
    await reviseMission(ctxA, {
      missionId: missionA.id,
      title: 'W044 Mission (v2)',
      urgency: 'critical',
      actor: { kind: 'person', label: 'COO' },
      rationale: 'w044 revision',
    });
    const unknownB = await recordUnknown(ctxB, {
      question: 'W044 question?',
      consequence: 'W044 consequence',
    });
    const missionB = await createMission(ctxB, missionInput([unknownB.id]));

    const ids = { mission: missionA.id, unknown: unknownA.id };
    const idsB = { mission: missionB.id, unknown: unknownB.id };
    const idKeys = ['mission', 'unknown'];

    return {
      module: 'missions',
      ctxA,
      ctxB,
      ids,
      idsB,
      idKeys,
      contextProbe: (ctx) => getMission(ctx, ids.mission!),
      reads: [
        {
          name: 'getMission',
          code: 'mission_not_found',
          run: (ctx, probeIds) => getMission(ctx, probeIds.mission!),
        },
        {
          name: 'getMissionVersion',
          code: 'mission_version_not_found',
          run: (ctx, probeIds) => getMissionVersion(ctx, { missionId: probeIds.mission!, version: 1 }),
        },
        {
          name: 'listMissionVersions',
          code: 'mission_not_found',
          run: (ctx, probeIds) => listMissionVersions(ctx, { missionId: probeIds.mission! }),
        },
      ],
      lists: [
        { name: 'listMissions', run: (ctx) => listMissions(ctx, {}) },
        {
          name: 'listMissions by shared title',
          run: (ctx) => listMissions(ctx, { search: 'W044 Mission' }),
        },
      ],
      writes: [
        {
          name: 'reviseMission',
          code: 'mission_not_found',
          run: (ctx, probeIds) =>
            reviseMission(ctx, {
              missionId: probeIds.mission!,
              title: 'w044 hijack',
              actor: { kind: 'person', label: 'COO' },
              rationale: 'w044 cross-tenant',
            }),
        },
        {
          name: 'completeMission',
          code: 'mission_not_found',
          run: (ctx, probeIds) =>
            completeMission(ctx, {
              missionId: probeIds.mission!,
              achievedConfidence: 0.9,
              outcome: 'w044 hijack',
              actor: { kind: 'person', label: 'COO' },
            }),
        },
        {
          name: 'abandonMission',
          code: 'mission_not_found',
          run: (ctx, probeIds) =>
            abandonMission(ctx, {
              missionId: probeIds.mission!,
              reason: 'w044 hijack',
              actor: { kind: 'person', label: 'COO' },
            }),
        },
        {
          name: 'createMission referencing another tenant\'s unknown',
          code: 'invalid_unknown_ref',
          run: (ctx, probeIds) => createMission(ctx, missionInput([probeIds.unknown!])),
        },
      ],
      checks: [],
    };
  },
};

// ---------------------------------------------------------------------------
// knowledge-acquisition
// ---------------------------------------------------------------------------

const knowledgeAcquisitionProbe: ModuleProbe = {
  module: 'knowledge-acquisition',
  setup: async () => {
    const tenantA = newId();
    const tenantB = newId();
    const ctxA = member(tenantA);
    const ctxB = member(tenantB);

    const seed = async (ctx: TenantContext, tenantId: string, suffix: string) => {
      // the full "askable employee" chain: person + active employee + verified linked identity
      const person = await createPerson(member(tenantId), { fullName: `W044 Person ${suffix}` });
      await createEmployee(member(tenantId), { personId: person.id, title: 'W044 Title' });
      const { identity } = await registerExternalIdentity(member(tenantId), {
        provider: 'slack',
        providerAccountId: `slack-w044-${suffix}`,
      });
      const manager = member(tenantId, [IDENTITY_AUTHORITY_ATTEST, IDENTITY_AUTHORITY_LINK]);
      const attested = await attestIdentity(manager, {
        identityId: identity.id,
        evidence: 'w044 attestation',
      });
      await linkExternalIdentity(manager, { personId: person.id, identityId: attested.id });

      const mission = await createMission(ctx, {
        title: 'W044 Acquisition Mission',
        knowledgeObjective: 'W044 knowledge objective?',
        affectedGoals: [],
        unknownIds: [],
        informationValue: 0.8,
        urgency: 'high',
        currentConfidence: 0.1,
        targetConfidence: 0.85,
        investigationBudget: { amount: 250_00, currency: 'EUR' },
        rewardBudget: { amount: 50_00, currency: 'EUR' },
        rewardTerms: null,
        candidateSources: [
          { kind: 'person', id: person.id, label: 'W044 VP' },
          { kind: 'system', label: 'w044-billing' },
        ],
        completionCriteria: 'W044 completion criteria.',
        actor: { kind: 'person', label: 'COO' },
        rationale: 'w044',
      });
      const plan = await planNextAcquisition(ctx, {
        missionId: mission.id,
        candidates: [
          {
            kind: 'person',
            id: person.id,
            label: 'W044 VP',
            relevance: 0.9,
            reliability: 0.9,
            freshness: 0.9,
            authority: 0.9,
            expectedQuality: 0.9,
            priorContributionValue: 0.5,
            cost: 0,
            access: 'allowed',
          },
          {
            kind: 'system',
            label: 'w044-billing',
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
        actor: { kind: 'system', label: 'w044-cognition' },
        rationale: 'w044',
      });
      await recordAcquisitionOutcome(ctx, { planId: plan.id, outcome: 'failed', note: 'w044' });
      return { person, mission, plan };
    };

    const a = await seed(ctxA, tenantA, 'a');
    const b = await seed(ctxB, tenantB, 'b');

    const ids = { plan: a.plan.id, mission: a.mission.id, person: a.person.id };
    const idsB = { plan: b.plan.id, mission: b.mission.id, person: b.person.id };
    const idKeys = ['plan', 'mission', 'person'];

    const planCandidatesForB = [
      {
        kind: 'person' as const,
        id: b.person.id,
        label: 'W044 VP',
        relevance: 0.9,
        reliability: 0.9,
        freshness: 0.9,
        authority: 0.9,
        expectedQuality: 0.9,
        priorContributionValue: 0.5,
        cost: 0,
        access: 'allowed' as const,
      },
      {
        kind: 'system' as const,
        label: 'w044-billing',
        relevance: 0.5,
        reliability: 0.5,
        freshness: 0.5,
        authority: 0.5,
        expectedQuality: 0.5,
        priorContributionValue: 0.5,
        cost: 0,
        access: 'allowed' as const,
      },
    ];

    return {
      module: 'knowledge-acquisition',
      ctxA,
      ctxB,
      ids,
      idsB,
      idKeys,
      contextProbe: (ctx) => getAcquisitionPlan(ctx, ids.plan!),
      reads: [
        {
          name: 'getAcquisitionPlan',
          code: 'plan_not_found',
          run: (ctx, probeIds) => getAcquisitionPlan(ctx, probeIds.plan!),
        },
      ],
      lists: [
        {
          name: 'listAcquisitionPlans for another tenant\'s mission',
          run: (ctx, probeIds) => listAcquisitionPlans(ctx, { missionId: probeIds.mission! }),
        },
      ],
      writes: [
        {
          name: 'planNextAcquisition for another tenant\'s mission',
          code: 'mission_not_found',
          run: (ctx, probeIds) =>
            planNextAcquisition(ctx, {
              missionId: probeIds.mission!,
              candidates: planCandidatesForB,
              actor: { kind: 'system', label: 'w044-cognition' },
              rationale: 'w044 cross-tenant',
            }),
        },
        {
          name: 'recordAcquisitionOutcome for another tenant\'s plan',
          code: 'plan_not_found',
          run: (ctx, probeIds) =>
            recordAcquisitionOutcome(ctx, {
              planId: probeIds.plan!,
              outcome: 'failed',
              note: 'w044 cross-tenant',
            }),
        },
      ],
      checks: [],
    };
  },
};

export const knowledgeProbes: ModuleProbe[] = [
  memoryProbe,
  epistemicsProbe,
  freshnessProbe,
  goalsProbe,
  missionsProbe,
  knowledgeAcquisitionProbe,
];
