// ============================================================================
// W049 — Chain Links (focused integration proofs)
// ============================================================================
//
// Companion to company-intelligence-loop.test.ts (the full end-to-end
// fixture). That file proves the WHOLE chain on one synthetic company; this
// one pins the LOAD-BEARING LINKS of the chain in isolation, so a regression
// in any single handoff is attributable without re-reading the whole story:
//
//   1. the canonical loop order IS the W049 chain order (pure);
//   2. goal relevance is enforced, not decorative (an archived goal is
//      refused by the goal-evaluation stage);
//   3. the mission → unknown link is validated cross-module (a foreign
//      unknown is refused);
//   4. employee acquisition is genuinely employee-gated (an inactive
//      employee is excluded; the planner falls through to the system) and
//      the family routing is deterministic (person → system → external,
//      no repeated attempts);
//   5. belief updates version with strictly increasing validFrom and
//      per-version provenance;
//   6. the capability gap transitions are real (a below-level supply
//      leaves a level shortfall; an adequate supply covers it);
//   7. measured outcomes freeze the deterministic verdict (met / exceeded /
//      missed) and realization is always grounded in a referenced
//      measurement of THIS outcome;
//   8. the recommendation gate is the §20 matrix (RECOMMEND allowed,
//      EXECUTE approval-required, self-approval forbidden).
//
// Same rules as the main fixture: public module contracts only (`@/modules/
// <m>/contract`), `@/infra/*` ports and the migration runner.
// ============================================================================

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { runMigrations } from '../../../scripts/migrate';

import { LOOP_STAGES } from '@/modules/cognition/contract';
import {
  createPerson,
  createEmployee,
  setEmployeeStatus,
  linkExternalIdentity,
} from '@/modules/people/contract';
import { attestIdentity, registerExternalIdentity } from '@/modules/identity/contract';
import { createGoal } from '@/modules/goals/contract';
import { recordObservation } from '@/modules/observations/contract';
import { recordUnknown } from '@/modules/epistemics/contract';
import { createMission } from '@/modules/missions/contract';
import {
  planNextAcquisition,
  recordAcquisitionOutcome,
} from '@/modules/knowledge-acquisition/contract';
import type { CandidateSignals } from '@/modules/knowledge-acquisition/contract';
import { formBelief, reviseBelief } from '@/modules/epistemics/contract';
import {
  analyzeGaps,
  registerCapability,
  registerRequirement,
  registerSupply,
} from '@/modules/capabilities/contract';
import {
  defineOutcome,
  recordMeasurement,
  settleOutcome,
} from '@/modules/learning/contract';
import { LearningError } from '@/modules/learning/contract';

const tenantId = newId();
const ctx: TenantContext = { tenantId, principalId: newId(), authority: [] };

beforeAll(async () => {
  await runMigrations(getDb());
});

afterAll(async () => {
  await closeDb();
});

// ---------------------------------------------------------------------------
// 1 — the canonical order is the chain order
// ---------------------------------------------------------------------------

describe('link 1 — the canonical loop order is the W049 chain order', () => {
  it('pins LOOP_STAGES to the frozen §19 sequence', () => {
    expect([...LOOP_STAGES]).toEqual([
      'observation',
      'evidence-memory',
      'world-update',
      'epistemic-evaluation',
      'goal-evaluation',
      'unknown-mission-evaluation',
      'knowledge-acquisition',
      'model-update',
      'risk-opportunity-capability-analysis',
      'recommendation-ask-proposal-action',
      'outcome',
      'learning',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

async function seedGoal(title: string): Promise<string> {
  const goal = await createGoal(ctx, {
    title,
    objective: `Objective of ${title}`,
    desiredState: `${title} achieved`,
    horizonEnd: '2027-12-31T00:00:00.000Z',
    owner: { kind: 'person', label: 'Owner' },
    priority: 'medium',
    successCriteria: `${title} criteria`,
    actor: { kind: 'person', label: 'Owner' },
  });
  return goal.id;
}

async function seedMission(
  unknownId: string | null,
  candidateSources: { kind: 'person' | 'system' | 'external'; id?: string | null; label: string }[],
): Promise<string> {
  const mission = await createMission(ctx, {
    title: 'Chain-links mission',
    knowledgeObjective: 'What does the links fixture need to know?',
    unknownIds: unknownId === null ? [] : [unknownId],
    informationValue: 0.5,
    urgency: 'medium',
    currentConfidence: 0.2,
    targetConfidence: 0.9,
    investigationBudget: { amount: 100_000, currency: 'USD' },
    rewardBudget: { amount: 10_000, currency: 'USD' },
    candidateSources,
    completionCriteria: 'answered',
    actor: { kind: 'system', label: 'chain-links' },
  });
  return mission.id;
}

const NEUTRAL: Omit<CandidateSignals, 'kind' | 'id' | 'label'> = {
  relevance: 0.8,
  reliability: 0.8,
  freshness: 0.8,
  authority: 0.8,
  expectedQuality: 0.8,
  priorContributionValue: 0,
  cost: 0,
  access: 'allowed',
};

/** The standard three-family menu (person → system → external, §7 order). */
function standardMenu(personId: string | null = null) {
  return [
    personId === null
      ? { kind: 'person' as const, label: 'Someone' }
      : { kind: 'person' as const, id: personId, label: 'The employee' },
    { kind: 'system' as const, label: 'The system' },
    { kind: 'external' as const, label: 'The benchmark' },
  ];
}

/** Signals for EVERY menu candidate (the planner rejects missing entries). */
function menuSignals(
  menu: ReturnType<typeof standardMenu>,
  overrides: Partial<Record<'person' | 'system' | 'external', Partial<CandidateSignals>>> = {},
): CandidateSignals[] {
  return menu.map((candidate) => ({
    ...candidate,
    ...NEUTRAL,
    ...(overrides[candidate.kind] ?? {}),
  })) as CandidateSignals[];
}

// ---------------------------------------------------------------------------
// 2 — goal relevance is enforced
// ---------------------------------------------------------------------------

describe('link 2 — goal relevance is enforced (archived goals are not direction)', () => {
  it('an archived goal cannot serve as a cycle\'s related goal', async () => {
    const goalId = await seedGoal('To be archived');
    // Archiving is a versioned lifecycle change (the goals contract's only
    // surgical status transition).
    const { reviseGoal } = await import('@/modules/goals/contract');
    const archived = await reviseGoal(ctx, {
      goalId,
      status: 'archived',
      actor: { kind: 'person', label: 'Owner' },
    });
    expect(archived.content.status).toBe('archived');

    // The goal-evaluation stage of a cognitive execution refuses it: goal
    // RELEVANCE means the CURRENT declared direction, not history.
    const { startExecution, runNextStage, CognitionError } = await import(
      '@/modules/cognition/contract'
    );
    const observation = await recordObservation(ctx, {
      kind: 'channel.message',
      payload: { text: 'trigger' },
      observedAt: new Date().toISOString(),
      source: { kind: 'source', label: 'test' },
      channel: 'api',
      confidence: { value: 0.5, method: 'test' },
    });
    const trace = await startExecution(ctx, {
      trigger: { kind: 'observation', id: observation.id },
      focus: { topics: ['links'], entities: [] },
      actor: { kind: 'system', label: 'chain-links' },
    });
    // Minimal drive up to stage 5.
    await runNextStage(ctx, {
      executionId: trace.id,
      stage: 'observation',
      reference: [observation.id],
    });
    await runNextStage(ctx, { executionId: trace.id, stage: 'evidence-memory' });
    await runNextStage(ctx, { executionId: trace.id, stage: 'world-update', update: null });
    await runNextStage(ctx, { executionId: trace.id, stage: 'epistemic-evaluation', claims: [] });
    await expect(
      runNextStage(ctx, {
        executionId: trace.id,
        stage: 'goal-evaluation',
        relatedGoalIds: [goalId],
      }),
    ).rejects.toBeInstanceOf(CognitionError);
  });
});

// ---------------------------------------------------------------------------
// 3 — the mission → unknown link is validated
// ---------------------------------------------------------------------------

describe('link 3 — the mission ↔ unknown link is a validated cross-module edge', () => {
  it('a foreign-tenant unknown id is refused (no existence leak, no silent link)', async () => {
    const foreignUnknownId = newId();
    await expect(seedMission(foreignUnknownId, standardMenu())).rejects.toMatchObject({
      code: 'invalid_unknown_ref',
    });
  });

  it('an in-tenant unknown links cleanly', async () => {
    const observation = await recordObservation(ctx, {
      kind: 'channel.message',
      payload: { text: 'evidence' },
      observedAt: new Date().toISOString(),
      source: { kind: 'source', label: 'test' },
      channel: 'api',
      confidence: { value: 0.5, method: 'test' },
    });
    const unknown = await recordUnknown(ctx, {
      question: 'What is the answer?',
      consequence: 'Without it the chain-links cannot proceed',
      relatedObservationIds: [observation.id],
    });
    const missionId = await seedMission(unknown.id, standardMenu());
    const { getMission } = await import('@/modules/missions/contract');
    const mission = await getMission(ctx, missionId);
    expect(mission.content.unknownIds).toEqual([unknown.id]);
  });
});

// ---------------------------------------------------------------------------
// 4 — acquisition family routing is deterministic and employee-gated
// ---------------------------------------------------------------------------

describe('link 4 — employee/system/external acquisition routing', () => {
  /** An ASK-able employee: person + active employment + verified identity. */
  async function seedVerifiedEmployee(fullName: string, account: string): Promise<string> {
    const person = await createPerson(ctx, { fullName });
    await createEmployee(ctx, { personId: person.id, title: 'Specialist' });
    const identityAdmin: TenantContext = {
      tenantId,
      principalId: newId(),
      authority: ['identity:attest'],
    };
    const identityLinker: TenantContext = {
      tenantId,
      principalId: newId(),
      authority: ['identity:link'],
    };
    const registered = await registerExternalIdentity(identityAdmin, {
      provider: 'slack',
      providerAccountId: account,
    });
    await attestIdentity(identityAdmin, {
      identityId: registered.identity.id,
      evidence: 'links fixture attestation',
    });
    await linkExternalIdentity(identityLinker, {
      personId: person.id,
      identityId: registered.identity.id,
    });
    return person.id;
  }

  it('an INACTIVE employee is excluded and the planner falls through to the system', async () => {
    const person = await createPerson(ctx, { fullName: 'Former Employee' });
    const employee = await createEmployee(ctx, {
      personId: person.id,
      title: 'Leaving role',
    });
    await setEmployeeStatus(ctx, { employeeId: employee.id, status: 'terminated' });

    const missionId = await seedMission(null, standardMenu(person.id));
    const plan = await planNextAcquisition(ctx, {
      missionId,
      candidates: menuSignals(standardMenu(person.id), {
        person: { relevance: 1 },
        system: { relevance: 0.9 },
        external: { relevance: 0.7 },
      }),
      actor: { kind: 'system', label: 'chain-links' },
    });
    // The person gate excludes the terminated employee (never ASK-able),
    // and the deterministic order selects the next-best source.
    const personRanking = plan.ranked.find((r) => r.candidate.kind === 'person');
    expect(personRanking?.status).toBe('excluded');
    expect(personRanking?.exclusion).toBe('employee_inactive');
    expect(plan.action).toBe('query-system');
  });

  it('a label-only person candidate cannot be targeted at an employee', async () => {
    const missionId = await seedMission(null, standardMenu());
    const plan = await planNextAcquisition(ctx, {
      missionId,
      candidates: menuSignals(standardMenu()),
      actor: { kind: 'system', label: 'chain-links' },
    });
    const personRanking = plan.ranked.find((r) => r.candidate.kind === 'person');
    expect(personRanking?.exclusion).toBe('person_unresolvable');
    // At equal scores the §7 kind order decides: system before external.
    expect(plan.action).toBe('query-system');
  });

  it('successive plans walk the menu without repeating attempts (lock 17)', async () => {
    const verifiedPersonId = await seedVerifiedEmployee('Ada Links', 'ada.links');
    const menu = standardMenu(verifiedPersonId);
    const signals = menuSignals(menu);
    const missionId = await seedMission(null, menu);
    const first = await planNextAcquisition(ctx, {
      missionId,
      candidates: signals,
      actor: { kind: 'system', label: 'chain-links' },
    });
    expect(first.chosen?.kind).toBe('person'); // highest §7 menu rank at equal score
    await recordAcquisitionOutcome(ctx, {
      planId: first.id,
      outcome: 'unavailable',
      note: 'out of office',
    });

    const second = await planNextAcquisition(ctx, {
      missionId,
      candidates: signals,
      actor: { kind: 'system', label: 'chain-links' },
    });
    expect(second.chosen?.kind).toBe('system');
    expect(
      second.ranked.find((r) => r.candidate.kind === 'person')?.exclusion,
    ).toBe('already_attempted');

    const third = await planNextAcquisition(ctx, {
      missionId,
      candidates: signals,
      actor: { kind: 'system', label: 'chain-links' },
    });
    expect(third.chosen?.kind).toBe('external');
    expect(
      third.ranked.filter((r) => r.status === 'excluded').map((r) => r.candidate.kind).sort(),
    ).toEqual(['person', 'system']);
  });
});

// ---------------------------------------------------------------------------
// 5 — belief updates version under discipline
// ---------------------------------------------------------------------------

describe('link 5 — belief updates are versioned understanding', () => {
  it('requires strictly increasing validFrom and keeps per-version provenance', async () => {
    const observationA = await recordObservation(ctx, {
      kind: 'channel.message',
      payload: { text: 'evidence a' },
      observedAt: new Date().toISOString(),
      source: { kind: 'source', label: 'test' },
      channel: 'api',
      confidence: { value: 0.6, method: 'test' },
    });
    const observationB = await recordObservation(ctx, {
      kind: 'channel.message',
      payload: { text: 'evidence b' },
      observedAt: new Date().toISOString(),
      source: { kind: 'source', label: 'test' },
      channel: 'api',
      confidence: { value: 0.7, method: 'test' },
    });

    const belief = await formBelief(ctx, {
      proposition: 'First understanding',
      confidence: { value: 0.6, method: 'test' },
      supportingObservationIds: [observationA.id],
      validFrom: '2026-01-01T00:00:00.000Z',
    });
    expect(belief.version).toBe(1);

    // A revision at or before the current version's validFrom is refused —
    // history is never rewritten (W006 discipline under W007).
    await expect(
      reviseBelief(ctx, {
        beliefId: belief.id,
        proposition: 'Overlapping revision',
        confidence: { value: 0.7, method: 'test' },
        supportingObservationIds: [observationB.id],
        validFrom: '2026-01-01T00:00:00.000Z',
      }),
    ).rejects.toMatchObject({ code: 'invalid_belief_input' });

    const revised = await reviseBelief(ctx, {
      beliefId: belief.id,
      proposition: 'Second understanding',
      confidence: { value: 0.8, method: 'test' },
      supportingObservationIds: [observationB.id],
      validFrom: '2026-02-01T00:00:00.000Z',
    });
    expect(revised.version).toBe(2);
    expect(revised.provenance.observationIds).toEqual([observationB.id]);
  });
});

// ---------------------------------------------------------------------------
// 6 — capability gap transitions are real
// ---------------------------------------------------------------------------

describe('link 6 — the capability gap math behind uncovered → covered', () => {
  it('a below-level supply leaves a level shortfall; an adequate supply covers it', async () => {
    const capability = await registerCapability(ctx, {
      name: `links-capability-${newId().slice(0, 8)}`,
      actor: { kind: 'system', label: 'chain-links' },
    });
    await registerRequirement(ctx, {
      capabilityId: capability.id,
      source: { kind: 'manual', label: 'links fixture' },
      level: 0.8,
      actor: { kind: 'system', label: 'chain-links' },
    });

    const short = await registerSupply(ctx, {
      capabilityId: capability.id,
      supplier: { kind: 'partner', label: 'Weak partner' },
      level: 0.5,
      actor: { kind: 'system', label: 'chain-links' },
    });
    expect(short.status).toBe('active');

    const afterWeak = await analyzeGaps(ctx, { capabilityId: capability.id });
    const weakGap = afterWeak.find((g) => g.capability.id === capability.id);
    expect(weakGap?.status).toBe('level_shortfall');
    expect(weakGap?.unmet[0]?.levelShortfall).toEqual({ required: 0.8, bestAvailable: 0.5 });

    await registerSupply(ctx, {
      capabilityId: capability.id,
      supplier: { kind: 'software', label: 'Adequate software' },
      level: 0.9,
      actor: { kind: 'system', label: 'chain-links' },
    });
    const afterAdequate = await analyzeGaps(ctx, { capabilityId: capability.id });
    const coveredGap = afterAdequate.find((g) => g.capability.id === capability.id);
    expect(coveredGap?.status).toBe('covered');
    expect(coveredGap?.unmet).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 7 — measured outcomes freeze the deterministic verdict
// ---------------------------------------------------------------------------

describe('link 7 — expected-versus-realized is deterministic and evidence-grounded', () => {
  it('settles met / exceeded / missed for the at_most direction', async () => {
    const seedOutcome = async (baseline: number, expected: number) => {
      const outcome = await defineOutcome(ctx, {
        subject: { kind: 'mission', id: newId(), label: 'links mission' },
        metricName: 'links metric',
        metricUnit: 'units',
        direction: 'at_most',
        baseline,
        expected,
        actor: { kind: 'system', label: 'chain-links' },
      });
      return outcome.id;
    };

    // exceeded: realized strictly below the at_most expectation.
    const exceededId = await seedOutcome(22, 10);
    const exceededMeasurement = await recordMeasurement(ctx, {
      outcomeId: exceededId,
      value: 8.5,
      actor: { kind: 'system', label: 'chain-links' },
    });
    const exceeded = await settleOutcome(ctx, {
      outcomeId: exceededId,
      measurementId: exceededMeasurement.id,
      actor: { kind: 'system', label: 'chain-links' },
    });
    expect(exceeded.realization?.assessment).toBe('exceeded');
    expect(exceeded.realization?.varianceVsExpected).toBe(-1.5);

    // met: exactly at the expectation.
    const metId = await seedOutcome(22, 10);
    const metMeasurement = await recordMeasurement(ctx, {
      outcomeId: metId,
      value: 10,
      actor: { kind: 'system', label: 'chain-links' },
    });
    const met = await settleOutcome(ctx, {
      outcomeId: metId,
      measurementId: metMeasurement.id,
      actor: { kind: 'system', label: 'chain-links' },
    });
    expect(met.realization?.assessment).toBe('met');

    // missed: realized above the at_most expectation.
    const missedId = await seedOutcome(22, 10);
    const missedMeasurement = await recordMeasurement(ctx, {
      outcomeId: missedId,
      value: 12,
      actor: { kind: 'system', label: 'chain-links' },
    });
    const missed = await settleOutcome(ctx, {
      outcomeId: missedId,
      measurementId: missedMeasurement.id,
      actor: { kind: 'system', label: 'chain-links' },
    });
    expect(missed.realization?.assessment).toBe('missed');
    expect(missed.realization?.improvementVsBaseline).toBe(-10);
  });

  it('realization must be grounded in a measurement of THIS outcome', async () => {
    const first = await defineOutcome(ctx, {
      subject: { kind: 'mission', id: newId(), label: 'first' },
      metricName: 'links metric',
      metricUnit: 'units',
      direction: 'at_most',
      baseline: 0,
      expected: 5,
      actor: { kind: 'system', label: 'chain-links' },
    });
    const second = await defineOutcome(ctx, {
      subject: { kind: 'mission', id: newId(), label: 'second' },
      metricName: 'links metric',
      metricUnit: 'units',
      direction: 'at_most',
      baseline: 0,
      expected: 5,
      actor: { kind: 'system', label: 'chain-links' },
    });
    const foreignMeasurement = await recordMeasurement(ctx, {
      outcomeId: second.id,
      value: 3,
      actor: { kind: 'system', label: 'chain-links' },
    });
    await expect(
      settleOutcome(ctx, {
        outcomeId: first.id,
        measurementId: foreignMeasurement.id,
        actor: { kind: 'system', label: 'chain-links' },
      }),
    ).rejects.toBeInstanceOf(LearningError);
  });
});

// ---------------------------------------------------------------------------
// 8 — the recommendation gate is the §20 matrix
// ---------------------------------------------------------------------------

describe('link 8 — the recommendation/authority gate', () => {
  it('RECOMMEND is allowed and EXECUTE is approval-required under the built-in floor', async () => {
    const { evaluateAuthorityMatrix, builtInDefaultMatrix } = await import(
      '@/modules/actions/contract'
    );
    const floor = builtInDefaultMatrix();
    expect(evaluateAuthorityMatrix(floor, 'RECOMMEND')).toBe('allowed');
    expect(evaluateAuthorityMatrix(floor, 'EXECUTE')).toBe('approval_required');
  });

  it('a pending EXECUTE request cannot be approved by its own requester', async () => {
    const { authorizeAction, decideApproval, getActionRequest } = await import(
      '@/modules/actions/contract'
    );
    const requester: TenantContext = { tenantId, principalId: newId(), authority: [] };
    const request = await authorizeAction(requester, {
      actionKind: 'capability-change',
      authorityLevel: 'EXECUTE',
      payload: { change: 'register-supply' },
      justification: 'links fixture',
    });
    expect(request.status).toBe('pending');
    await expect(
      decideApproval(requester, { requestId: request.id, decision: 'approve' }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    const unchanged = await getActionRequest(requester, { requestId: request.id });
    expect(unchanged.status).toBe('pending');
  });
});
