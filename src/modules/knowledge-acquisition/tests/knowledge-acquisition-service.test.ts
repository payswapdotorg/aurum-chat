// Integration tests for the knowledge-acquisition module against the
// embedded PostgreSQL (PGlite, `:memory:`) through the db port. Covers the
// W012 acceptance:
//
//  * CHOOSE THE NEXT SOURCE/ACTION among employees, managers, systems,
//    documents, external sources, agents and analyses:
//      - a six-kind menu selects the deterministic top scorer; the action
//        maps onto the chosen kind; the full ranked rationale (separately
//        represented signals, score, cost share, dominant signal,
//        exclusions) is persisted and round-trips;
//      - selection is deterministic (identical menus + signals →
//        identical decisions) and moves when signals move (ADR-0018:
//        reliability/relevance/cost changes re-rank);
//      - the planner is mission-driven: signal entries outside the
//        mission's current menu are rejected, missing coverage is
//        rejected, and the plan records the mission version it saw.
//  * MISSION-DRIVEN TARGETED EMPLOYEE QUESTIONING:
//      - an askable person (readable person + active employee + verified
//        linked identity) is selected for asking; the question is
//        composed from the mission's knowledge objective and addressed to
//        the employee by name; the ASK authority evaluation is persisted;
//      - person gates exclude label-only, unresolvable (incl. foreign
//        tenant), non-employee, terminated and unreachable persons with
//        uniform reasons (no existence leak);
//      - the authority matrix gates questioning: forbidden excludes every
//        person candidate; approval_required keeps the question drafted
//        but flagged.
//  * NOT BLINDLY QUERYING (lock 17): attempted candidates are excluded on
//    the next pass (across mission revisions too), budget overruns are
//    excluded while zero-cost candidates stay selectable, and a fully
//    exhausted/blocked menu decides 'no_candidate'.
//  * OUTCOMES: answered requires evidence (recorded as an immutable
//    observation through the observations contract with the acquired
//    source as provenance); unavailable/failed require a note; the first
//    outcome wins; no_candidate plans cannot be resolved.
//  * APPEND-ONLY: UPDATE/DELETE/TRUNCATE are rejected by triggers on both
//    tables.
//  * TENANT ISOLATION (ADR-0001) with uniform not-found semantics.
//  * the read surface: getAcquisitionPlan round-trips; listAcquisitionPlans
//    filters by mission/decision/action, latest first.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { ACTIONS_AUTHORITY_ADMINISTER, setAuthorityPolicy } from '@/modules/actions/contract';
import {
  IDENTITY_AUTHORITY_ATTEST,
  IDENTITY_AUTHORITY_LINK,
  attestIdentity,
  registerExternalIdentity,
} from '@/modules/identity/contract';
import { getObservation } from '@/modules/observations/contract';
import {
  createEmployee,
  createPerson,
  linkExternalIdentity,
  setEmployeeStatus,
  type Person,
} from '@/modules/people/contract';
import {
  completeMission,
  createMission,
  reviseMission,
  type CreateMissionInput,
  type Mission,
  type MissionCandidateInput,
  type MissionCandidateKind,
} from '@/modules/missions/contract';
import { KnowledgeAcquisitionError } from '../errors';
import * as kaContract from '../contract';
import type { AcquisitionPlan, CandidateSignals, PlanNextAcquisitionInput, RankedCandidate } from '../types';
import { runMigrations } from '../../../../scripts/migrate';

const {
  getAcquisitionPlan,
  listAcquisitionPlans,
  planNextAcquisition,
  recordAcquisitionOutcome,
} = kaContract;

// Dedicated tenants keep each concern's data isolated from the others.
const tenantA = newId();
const tenantB = newId();
const tenantGates = newId();
const tenantPolicy = newId();
const tenantLoop = newId();
const tenantBudget = newId();
const tenantIso = newId();
const tenantReads = newId();
const tenantList = newId();

function member(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: [] };
}

function admin(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: [ACTIONS_AUTHORITY_ADMINISTER] };
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
    expect(error).toBeInstanceOf(KnowledgeAcquisitionError);
    expect((error as KnowledgeAcquisitionError).code).toBe(code);
  }
}

// ---------------------------------------------------------------------------
// Seeds
// ---------------------------------------------------------------------------

let identityCounter = 0;

/** A person with an active employment and a verified linked identity. */
async function askableEmployee(
  tenantId: string,
  fullName: string,
  options: { employee?: boolean; terminate?: boolean; verified?: boolean } = {},
): Promise<Person> {
  const person = await createPerson(member(tenantId), { fullName });
  if (options.employee !== false) {
    const employee = await createEmployee(member(tenantId), {
      personId: person.id,
      title: `Title of ${fullName}`,
    });
    if (options.terminate === true) {
      await setEmployeeStatus(member(tenantId), { employeeId: employee.id, status: 'terminated' });
    }
  }
  if (options.verified !== false) {
    identityCounter += 1;
    const registered = await registerExternalIdentity(member(tenantId), {
      provider: 'slack',
      providerAccountId: `slack-${identityCounter}`,
    });
    const attested = await attestIdentity(manager(tenantId), {
      identityId: registered.identity.id,
      evidence: `admin attestation for ${fullName}`,
    });
    await linkExternalIdentity(manager(tenantId), { personId: person.id, identityId: attested.id });
  }
  return person;
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
    investigationBudget: { amount: 250_00, currency: 'EUR' },
    rewardBudget: { amount: 50_00, currency: 'EUR' },
    rewardTerms: null,
    candidateSources: [],
    completionCriteria: 'A validated root-cause explanation with confidence >= 0.85.',
    actor: { kind: 'person', label: 'COO' },
    rationale: 'goal-gap-2026-09',
    ...overrides,
  };
}

async function seedMission(
  ctx: TenantContext,
  overrides: Partial<CreateMissionInput> = {},
): Promise<Mission> {
  return createMission(ctx, missionInput(overrides));
}

/** Uniform signal vector; overrides bump individual dimensions. */
function sig(
  kind: MissionCandidateKind,
  ref: { id?: string | null; label?: string | null },
  overrides: Partial<CandidateSignals> = {},
  level = 0.5,
): CandidateSignals {
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
    access: 'allowed',
    ...overrides,
  };
}

function planInput(
  missionId: string,
  candidates: CandidateSignals[],
  rationale: string | null = null,
): PlanNextAcquisitionInput {
  return { missionId, candidates, actor: { kind: 'system', label: 'aurum-cognition' }, rationale };
}

function answer(planId: string, payload: Record<string, unknown> = { answer: 'Pricing drove churn.' }) {
  return {
    planId,
    outcome: 'answered' as const,
    evidence: {
      payload,
      confidence: { value: 0.8, method: 'source_trust', basis: 'direct account' },
    },
  };
}

function rankedOf(plan: AcquisitionPlan, kind: MissionCandidateKind): RankedCandidate {
  const entry = plan.ranked.find((candidate) => candidate.candidate.kind === kind);
  expect(entry).toBeDefined();
  return entry!;
}

beforeAll(async () => {
  await runMigrations(getDb());
});

afterAll(async () => {
  await closeDb();
});

// ---------------------------------------------------------------------------
// Contract surface
// ---------------------------------------------------------------------------

describe('contract surface (the module exposes exactly its public operations)', () => {
  it('pins the export set — no mutation or erase operation exists', () => {
    // There is deliberately no updatePlan, no reRank, no deletePlan, no
    // unAnswer: planner decisions and outcomes are append-only evidence.
    expect(Object.keys(kaContract).sort()).toEqual(
      [
        'ACQUISITION_ACTIONS',
        'ACQUISITION_ACTION_KINDS',
        'ACQUISITION_CHANNEL',
        'ACQUISITION_OUTCOME_KINDS',
        'ACCESS_SCOPES',
        'ANSWER_OBSERVATION_KIND',
        'ASK_ACTION_KIND',
        'ASK_AUTHORITY_LEVEL',
        'CANDIDATE_KIND_ORDER',
        'DEFAULT_LIST_LIMIT',
        'EXCLUSION_REASONS',
        'KnowledgeAcquisitionError',
        'MAX_CONFIDENCE_METHOD_LENGTH',
        'MAX_COST_AMOUNT',
        'MAX_LABEL_LENGTH',
        'MAX_LIST_LIMIT',
        'MAX_NOTE_LENGTH',
        'MAX_PERSON_NAME_LENGTH',
        'MAX_PLAN_CANDIDATES',
        'MAX_QUESTION_LENGTH',
        'MAX_RATIONALE_LENGTH',
        'PLAN_DECISIONS',
        'SIGNAL_WEIGHTS',
        'candidateKey',
        'composeTargetedQuestion',
        'computeCostShare',
        'getAcquisitionPlan',
        'isAccessScope',
        'isAcquisitionActionKind',
        'isAcquisitionOutcomeKind',
        'isPlanDecision',
        'isUuid',
        'listAcquisitionPlans',
        'orderRankedCandidates',
        'planNextAcquisition',
        'recordAcquisitionOutcome',
        'scoreCandidateSignals',
      ].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// Selection over the full §7 menu
// ---------------------------------------------------------------------------

describe('planNextAcquisition (choosing the next source/action)', () => {
  it('selects the deterministic top scorer from a six-kind menu and maps the action', async () => {
    const ctx = member(tenantA);
    const vp = await askableEmployee(tenantA, 'Ada Lovelace');
    const mission = await seedMission(ctx, {
      candidateSources: [
        { kind: 'person', id: vp.id, label: 'VP Customer Success' },
        { kind: 'system', label: 'billing-export' },
        { kind: 'document', label: 'Q3 pricing memo' },
        { kind: 'external', label: 'industry churn benchmark' },
        { kind: 'agent', label: 'churn-analyst' },
        { kind: 'analysis', label: 'cohort churn model' },
      ],
    });

    const plan = await planNextAcquisition(
      ctx,
      planInput(mission.id, [
        sig('person', { id: vp.id, label: 'VP Customer Success' }, {}, 0.9),
        sig('system', { label: 'billing-export' }),
        sig('document', { label: 'Q3 pricing memo' }),
        sig('external', { label: 'industry churn benchmark' }),
        sig('agent', { label: 'churn-analyst' }),
        sig('analysis', { label: 'cohort churn model' }),
      ]),
    );

    expect(plan.decision).toBe('selected');
    expect(plan.missionId).toBe(mission.id);
    expect(plan.missionVersion).toBe(mission.version);
    expect(plan.chosen).toEqual({ kind: 'person', id: vp.id, label: 'VP Customer Success' });
    expect(plan.action).toBe('ask-person');
    expect(plan.estimatedCost).toBe(0);
    expect(plan.budgetRemaining).toBe(250_00);
    expect(plan.budgetCurrency).toBe('EUR');
    expect(plan.ranked).toHaveLength(6);
    // Employees and systems compete on the same dimensions: the snapshot
    // carries every candidate's separately represented signals + score.
    const person = rankedOf(plan, 'person');
    expect(person.signals).toEqual({
      relevance: 0.9, reliability: 0.9, freshness: 0.9, authority: 0.9,
      expectedQuality: 0.9, priorContributionValue: 0.9, cost: 0, access: 'allowed',
    });
    expect(person.status).toBe('eligible');
    expect(person.dominantSignal).toBe('relevance');
    const system = rankedOf(plan, 'system');
    expect(system.score).toBeLessThan(person.score);
    expect(plan.ranked.map((entry) => entry.score)).toEqual(
      [...plan.ranked.map((entry) => entry.score)].sort((a, b) => b - a),
    );
    // Audit quartet: who (actor + principal), when, what, why.
    expect(plan.actor).toEqual({ kind: 'system', id: null, label: 'aurum-cognition' });
    expect(plan.plannedByPrincipal).toBe(ctx.principalId);
    expect(plan.rationale).toBeNull();
    expect(Date.parse(plan.recordedAt)).not.toBeNaN();
    expect(plan.outcome).toBeNull();
  });

  it('maps every candidate kind onto its acquisition action', async () => {
    const ctx = member(tenantA);
    const kinds: MissionCandidateKind[] = ['system', 'document', 'external', 'agent', 'analysis'];
    for (const kind of kinds) {
      const mission = await seedMission(ctx, { candidateSources: [{ kind, label: `the-${kind}` }] });
      const plan = await planNextAcquisition(ctx, planInput(mission.id, [sig(kind, { label: `the-${kind}` })]));
      expect(plan.decision, kind).toBe('selected');
      expect(plan.action, kind).toBe(kaContract.ACQUISITION_ACTIONS[kind]);
      expect(plan.question, kind).toBeNull(); // only ask-person composes a question
      expect(plan.askPolicy, kind).toBeNull(); // no person candidates in the menu
    }
  });

  it('is deterministic: identical menus and signals produce identical decisions', async () => {
    const ctx = member(tenantA);
    const vp = await askableEmployee(tenantA, 'Grace Hopper');
    const candidates: CandidateSignals[] = [
      sig('person', { id: vp.id }, { reliability: 0.7 }, 0.6),
      sig('system', { label: 'billing-export' }, { cost: 40_00 }, 0.55),
    ];
    const first = await planNextAcquisition(
      ctx,
      planInput((await seedMission(ctx, { candidateSources: [
        { kind: 'person', id: vp.id },
        { kind: 'system', label: 'billing-export' },
      ] })).id, candidates),
    );
    const second = await planNextAcquisition(
      ctx,
      planInput((await seedMission(ctx, { candidateSources: [
        { kind: 'person', id: vp.id },
        { kind: 'system', label: 'billing-export' },
      ] })).id, candidates),
    );
    expect(second.chosen).toEqual(first.chosen);
    expect(second.action).toBe(first.action);
    expect(second.ranked.map((entry) => [entry.candidate.kind, entry.score, entry.status, entry.exclusion])).toEqual(
      first.ranked.map((entry) => [entry.candidate.kind, entry.score, entry.status, entry.exclusion]),
    );
  });

  it('re-ranks when signals change (ADR-0018: selection follows the evidence)', async () => {
    const ctx = member(tenantA);
    const vp = await askableEmployee(tenantA, 'Katherine Johnson');
    const menu: MissionCandidateInput[] = [
      { kind: 'person', id: vp.id, label: 'Support lead' },
      { kind: 'system', label: 'billing-export' },
    ];
    const personFavored = await planNextAcquisition(
      ctx,
      planInput((await seedMission(ctx, { candidateSources: menu })).id, [
        sig('person', { id: vp.id, label: 'Support lead' }, {}, 0.9),
        sig('system', { label: 'billing-export' }, {}, 0.4),
      ]),
    );
    expect(personFavored.action).toBe('ask-person');
    expect(rankedOf(personFavored, 'person').dominantSignal).toBe('relevance');

    const systemFavored = await planNextAcquisition(
      ctx,
      planInput((await seedMission(ctx, { candidateSources: menu })).id, [
        sig('person', { id: vp.id, label: 'Support lead' }, {}, 0.2),
        sig('system', { label: 'billing-export' }, {}, 0.95),
      ]),
    );
    expect(systemFavored.action).toBe('query-system');
    // The persisted rationale identifies which signal dominates the winner.
    expect(rankedOf(systemFavored, 'system').dominantSignal).toBe('relevance');
    expect(rankedOf(systemFavored, 'system').score).toBeGreaterThan(
      rankedOf(systemFavored, 'person').score,
    );
  });

  it('is mission-driven: signals must cover exactly the mission menu', async () => {
    const ctx = member(tenantA);
    const vp = await askableEmployee(tenantA, 'Mary Jackson');
    const mission = await seedMission(ctx, {
      candidateSources: [
        { kind: 'person', id: vp.id },
        { kind: 'system', label: 'billing-export' },
      ],
    });
    // extra signal for a source the mission never declared
    await expectCode('invalid_plan_input', () =>
      planNextAcquisition(ctx, planInput(mission.id, [
        sig('person', { id: vp.id }),
        sig('system', { label: 'billing-export' }),
        sig('document', { label: 'undeclared memo' }),
      ])),
    );
    // missing coverage for a declared candidate
    await expectCode('invalid_plan_input', () =>
      planNextAcquisition(ctx, planInput(mission.id, [sig('person', { id: vp.id })])),
    );
    // nothing was persisted by the failed passes
    expect(await listAcquisitionPlans(ctx, { missionId: mission.id })).toEqual([]);
  });

  it('rejects unknown, malformed and foreign-tenant mission ids as mission_not_found (no leak)', async () => {
    const ctx = member(tenantA);
    await expectCode('mission_not_found', () => planNextAcquisition(ctx, planInput(newId(), [])));
    const foreign = await seedMission(member(tenantB));
    await expectCode('mission_not_found', () =>
      planNextAcquisition(ctx, planInput(foreign.id, [])),
    );
  });

  it('refuses to plan a terminal mission', async () => {
    const ctx = member(tenantA);
    const mission = await seedMission(ctx);
    await completeMission(ctx, {
      missionId: mission.id,
      achievedConfidence: 0.9,
      outcome: 'Root cause identified.',
      actor: { kind: 'person', label: 'COO' },
    });
    await expectCode('mission_not_active', () => planNextAcquisition(ctx, planInput(mission.id, [])));
  });
});

// ---------------------------------------------------------------------------
// Mission-driven targeted employee questioning (the acceptance core)
// ---------------------------------------------------------------------------

describe('targeted employee questioning', () => {
  it('asks an askable employee a targeted, mission-derived question under the default ASK policy', async () => {
    const ctx = member(tenantGates);
    const vp = await askableEmployee(tenantGates, 'Ada Lovelace');
    const mission = await seedMission(ctx, {
      candidateSources: [
        { kind: 'person', id: vp.id, label: 'VP Customer Success' },
        { kind: 'system', label: 'billing-export' },
      ],
    });

    const plan = await planNextAcquisition(
      ctx,
      planInput(mission.id, [
        sig('person', { id: vp.id, label: 'VP Customer Success' }, {}, 0.9),
        sig('system', { label: 'billing-export' }),
      ]),
    );

    expect(plan.decision).toBe('selected');
    expect(plan.action).toBe('ask-person');
    // TARGETED: addressed to the resolved employee by directory name.
    expect(plan.question).toContain('Ada Lovelace');
    // MISSION-DRIVEN: derived from the mission's knowledge objective.
    expect(plan.question).toContain(mission.content.knowledgeObjective);
    expect(plan.question).toContain('?');
    // The default built-in matrix allows ASK.
    expect(plan.askPolicy).toEqual({ outcome: 'allowed', resolvedVia: 'built-in' });
  });

  it('excludes label-only and unresolvable persons (uniformly — foreign ids read like missing)', async () => {
    const ctx = member(tenantGates);
    const foreignPerson = await askableEmployee(tenantB, 'Foreign Person');
    const missingId = newId();
    const mission = await seedMission(ctx, {
      candidateSources: [
        { kind: 'person', label: 'The ghost' }, // label-only: cannot target an employee
        { kind: 'person', id: missingId }, // no such person in this tenant
        { kind: 'person', id: foreignPerson.id }, // another tenant's person
        { kind: 'system', label: 'billing-export' },
      ],
    });

    const plan = await planNextAcquisition(
      ctx,
      planInput(mission.id, [
        sig('person', { label: 'The ghost' }, {}, 0.9),
        sig('person', { id: missingId }, {}, 0.9),
        sig('person', { id: foreignPerson.id }, {}, 0.9),
        sig('system', { label: 'billing-export' }),
      ]),
    );

    expect(plan.action).toBe('query-system'); // the only askable menu entry left
    expect(rankedOf(plan, 'person').exclusion ?? null).not.toBeNull();
    const persons = plan.ranked.filter((entry) => entry.candidate.kind === 'person');
    expect(persons).toHaveLength(3);
    for (const person of persons) {
      expect(person.status).toBe('excluded');
      expect(person.exclusion).toBe('person_unresolvable');
    }
    // The ask policy was still evaluated (the menu contains persons) and
    // recorded even though a system won.
    expect(plan.askPolicy).toEqual({ outcome: 'allowed', resolvedVia: 'built-in' });
  });

  it('excludes persons without active employment (no employee record, terminated)', async () => {
    const ctx = member(tenantGates);
    const noEmployee = await askableEmployee(tenantGates, 'Contractor Carl', { employee: false });
    const terminated = await askableEmployee(tenantGates, 'Ex Employee', { terminate: true });
    const mission = await seedMission(ctx, {
      candidateSources: [
        { kind: 'person', id: noEmployee.id },
        { kind: 'person', id: terminated.id },
      ],
    });

    const plan = await planNextAcquisition(
      ctx,
      planInput(mission.id, [
        sig('person', { id: noEmployee.id }, {}, 0.9),
        sig('person', { id: terminated.id }, {}, 0.9),
      ]),
    );

    expect(plan.decision).toBe('no_candidate');
    expect(rankedOf(plan, 'person').status === 'excluded').toBe(true);
    const byName = new Map(plan.ranked.map((entry) => [entry.candidate.id, entry.exclusion]));
    expect(byName.get(noEmployee.id)).toBe('employee_inactive');
    expect(byName.get(terminated.id)).toBe('employee_inactive');
  });

  it('excludes persons without a verified linked channel identity', async () => {
    const ctx = member(tenantGates);
    const unverified = await askableEmployee(tenantGates, 'Unlinked Uma', { verified: false });
    const mission = await seedMission(ctx, { candidateSources: [{ kind: 'person', id: unverified.id }] });

    const plan = await planNextAcquisition(
      ctx,
      planInput(mission.id, [sig('person', { id: unverified.id }, {}, 0.9)]),
    );

    expect(plan.decision).toBe('no_candidate');
    expect(rankedOf(plan, 'person').exclusion).toBe('person_unreachable');
  });

  it('forbids questioning when the authority matrix forbids ASK employee-messaging', async () => {
    const tenant = tenantPolicy;
    const ctx = member(tenant);
    await setAuthorityPolicy(admin(tenant), {
      actionKind: 'employee-messaging',
      forbiddenLevels: ['ASK'],
    });
    const vp = await askableEmployee(tenant, 'Policy Patty');
    const mission = await seedMission(ctx, {
      candidateSources: [
        { kind: 'person', id: vp.id },
        { kind: 'system', label: 'billing-export' },
      ],
    });

    const plan = await planNextAcquisition(
      ctx,
      planInput(mission.id, [
        sig('person', { id: vp.id }, {}, 0.95),
        sig('system', { label: 'billing-export' }, {}, 0.3),
      ]),
    );

    // Explicit access policy overrides ranking: the person is excluded
    // even though they out-score the system.
    expect(rankedOf(plan, 'person').exclusion).toBe('ask_policy_forbidden');
    expect(plan.askPolicy).toEqual({ outcome: 'forbidden', resolvedVia: 'kind' });
    expect(plan.action).toBe('query-system');
    expect(plan.question).toBeNull();
  });

  it('drafts but gates the question when the matrix requires approval to ask', async () => {
    const tenant = tenantPolicy;
    const ctx = member(tenant);
    await setAuthorityPolicy(admin(tenant), {
      actionKind: 'employee-messaging',
      approvalLevels: ['ASK'],
    });
    const vp = await askableEmployee(tenant, 'Approval Al');
    const mission = await seedMission(ctx, { candidateSources: [{ kind: 'person', id: vp.id }] });

    const plan = await planNextAcquisition(
      ctx,
      planInput(mission.id, [sig('person', { id: vp.id }, {}, 0.9)]),
    );

    expect(plan.decision).toBe('selected');
    expect(plan.action).toBe('ask-person');
    expect(plan.question).toContain('Approval Al');
    expect(plan.askPolicy).toEqual({ outcome: 'approval_required', resolvedVia: 'kind' });
  });
});

// ---------------------------------------------------------------------------
// Next-best, not everything (lock 17)
// ---------------------------------------------------------------------------

describe('not blindly querying all sources', () => {
  it('moves to the next source after an outcome, and exhausts to no_candidate', async () => {
    const ctx = member(tenantLoop);
    const vp = await askableEmployee(tenantLoop, 'Loop Lisa');
    const mission = await seedMission(ctx, {
      candidateSources: [
        { kind: 'person', id: vp.id },
        { kind: 'system', label: 'billing-export' },
      ],
    });
    const signals: CandidateSignals[] = [
      sig('person', { id: vp.id }, {}, 0.9),
      sig('system', { label: 'billing-export' }, {}, 0.5),
    ];

    const first = await planNextAcquisition(ctx, planInput(mission.id, signals));
    expect(first.action).toBe('ask-person');

    await recordAcquisitionOutcome(ctx, answer(first.id));

    const second = await planNextAcquisition(ctx, planInput(mission.id, signals));
    expect(second.action).toBe('query-system');
    expect(rankedOf(second, 'person').exclusion).toBe('already_attempted');

    await recordAcquisitionOutcome(ctx, {
      planId: second.id,
      outcome: 'failed',
      note: 'export endpoint down',
    });

    const third = await planNextAcquisition(ctx, planInput(mission.id, signals));
    expect(third.decision).toBe('no_candidate');
    expect(third.chosen).toBeNull();
    expect(third.action).toBeNull();
    expect(third.question).toBeNull();
    expect(third.estimatedCost).toBeNull();
    expect(third.ranked.every((entry) => entry.exclusion === 'already_attempted')).toBe(true);
    // A no_candidate plan has no action to resolve.
    await expectCode('invalid_outcome_input', () =>
      recordAcquisitionOutcome(ctx, { planId: third.id, outcome: 'failed', note: 'nothing to fail' }),
    );
  });

  it('remembers attempts across mission revisions (the candidate key is stable)', async () => {
    const ctx = member(tenantLoop);
    const vp = await askableEmployee(tenantLoop, 'Revision Rae');
    const mission = await seedMission(ctx, {
      candidateSources: [
        { kind: 'person', id: vp.id },
        { kind: 'system', label: 'billing-export' },
      ],
    });
    const first = await planNextAcquisition(ctx, planInput(mission.id, [
      sig('person', { id: vp.id }, {}, 0.9),
      sig('system', { label: 'billing-export' }),
    ]));
    expect(first.action).toBe('ask-person');
    await recordAcquisitionOutcome(ctx, answer(first.id));

    // The menu is revised (a document joins); the attempted person keeps
    // its already_attempted exclusion under the same key.
    const revised = await reviseMission(ctx, {
      missionId: mission.id,
      candidateSources: [
        { kind: 'person', id: vp.id },
        { kind: 'system', label: 'billing-export' },
        { kind: 'document', label: 'Q3 pricing memo' },
      ],
      actor: { kind: 'person', label: 'COO' },
      rationale: 'widened the menu',
    });
    const second = await planNextAcquisition(ctx, planInput(revised.id, [
      sig('person', { id: vp.id }, {}, 0.9),
      sig('system', { label: 'billing-export' }),
      sig('document', { label: 'Q3 pricing memo' }),
    ]));
    expect(second.missionVersion).toBe(revised.version);
    expect(rankedOf(second, 'person').exclusion).toBe('already_attempted');
    expect(second.ranked).toHaveLength(3);
  });

  it('respects the mission budget: over-budget candidates are excluded, zero-cost ones stay selectable', async () => {
    const ctx = member(tenantBudget);
    const mission = await seedMission(ctx, {
      investigationBudget: { amount: 100_00, currency: 'EUR' },
      candidateSources: [
        { kind: 'analysis', label: 'cohort churn model' },
        { kind: 'system', label: 'billing-export' },
        { kind: 'external', label: 'paid benchmark' },
      ],
    });

    // the analysis costs 50_00 and scores highest; the external benchmark
    // would cost 90_00; the system is free.
    const first = await planNextAcquisition(ctx, planInput(mission.id, [
      sig('analysis', { label: 'cohort churn model' }, { cost: 50_00 }, 0.9),
      sig('external', { label: 'paid benchmark' }, { cost: 90_00 }, 0.9),
      sig('system', { label: 'billing-export' }, {}, 0.5),
    ]));
    expect(first.action).toBe('run-analysis');
    expect(first.estimatedCost).toBe(50_00);
    expect(first.budgetRemaining).toBe(100_00);

    await recordAcquisitionOutcome(ctx, answer(first.id, { model: 'churn cohort 3x' }));

    // 50_00 committed: the 90_00 benchmark is now over budget even though
    // it out-scores the free system — the budget gate overrides the score.
    const second = await planNextAcquisition(ctx, planInput(mission.id, [
      sig('analysis', { label: 'cohort churn model' }, { cost: 50_00 }, 0.9),
      sig('external', { label: 'paid benchmark' }, { cost: 90_00 }, 0.9),
      sig('system', { label: 'billing-export' }, {}, 0.5),
    ]));
    expect(second.budgetRemaining).toBe(50_00);
    expect(second.ranked.find((entry) => entry.candidate.label === 'paid benchmark')!.exclusion).toBe('over_budget');
    expect(rankedOf(second, 'analysis').exclusion).toBe('already_attempted');
    expect(second.action).toBe('query-system');
    expect(second.estimatedCost).toBe(0);

    // A fully-committed budget still allows zero-cost acquisition.
    const drained = await seedMission(ctx, {
      investigationBudget: { amount: 50_00, currency: 'EUR' },
      candidateSources: [
        { kind: 'external', label: 'benchmark' },
        { kind: 'document', label: 'memo' },
      ],
    });
    const paid = await planNextAcquisition(ctx, planInput(drained.id, [
      sig('external', { label: 'benchmark' }, { cost: 50_00 }, 0.9),
      sig('document', { label: 'memo' }),
    ]));
    expect(paid.action).toBe('fetch-external');
    await recordAcquisitionOutcome(ctx, answer(paid.id));
    const free = await planNextAcquisition(ctx, planInput(drained.id, [
      sig('external', { label: 'benchmark' }, { cost: 50_00 }, 0.9),
      sig('document', { label: 'memo' }),
    ]));
    expect(free.budgetRemaining).toBe(0);
    expect(free.action).toBe('retrieve-document'); // zero-cost still selectable
  });

  it('excludes access-forbidden candidates (explicit access scope is never overridden)', async () => {
    const ctx = member(tenantBudget);
    const mission = await seedMission(ctx, {
      candidateSources: [
        { kind: 'system', label: 'locked-vault' },
        { kind: 'system', label: 'billing-export' },
      ],
    });
    const plan = await planNextAcquisition(ctx, planInput(mission.id, [
      sig('system', { label: 'locked-vault' }, { access: 'forbidden' }, 0.99),
      sig('system', { label: 'billing-export' }, {}, 0.3),
    ]));
    const vault = plan.ranked.find((entry) => entry.candidate.label === 'locked-vault')!;
    const open = plan.ranked.find((entry) => entry.candidate.label === 'billing-export')!;
    expect(vault.exclusion).toBe('access_forbidden');
    expect(open.status).toBe('eligible');
    expect(plan.action).toBe('query-system');
    expect(plan.chosen!.label).toBe('billing-export');
  });
});

// ---------------------------------------------------------------------------
// Outcomes and evidence
// ---------------------------------------------------------------------------

describe('recordAcquisitionOutcome', () => {
  it('records an answered acquisition as immutable evidence with the acquired source as provenance', async () => {
    const ctx = member(tenantReads);
    const vp = await askableEmployee(tenantReads, 'Evidence Eve');
    const mission = await seedMission(ctx, {
      candidateSources: [{ kind: 'person', id: vp.id, label: 'VP Customer Success' }],
    });
    const plan = await planNextAcquisition(ctx, planInput(mission.id, [
      sig('person', { id: vp.id, label: 'VP Customer Success' }, {}, 0.9),
    ]));

    const resolved = await recordAcquisitionOutcome(ctx, answer(plan.id, {
      answer: 'The Q3 pricing change drove churn.',
    }));

    expect(resolved.outcome).toMatchObject({
      planId: plan.id,
      outcome: 'answered',
      note: null,
      recordedByPrincipal: ctx.principalId,
    });
    expect(resolved.outcome!.evidenceObservationId).not.toBeNull();

    // The evidence is a real observation (W004): provenance points at the
    // acquired person, and the payload/confidence round-trip.
    const observation = await getObservation(ctx, resolved.outcome!.evidenceObservationId!);
    expect(observation.kind).toBe('acquisition.answer');
    expect(observation.channel).toBe('knowledge-acquisition');
    expect(observation.source).toEqual({ kind: 'person', id: vp.id, label: 'VP Customer Success' });
    expect(observation.payload).toEqual({ answer: 'The Q3 pricing change drove churn.' });
    expect(observation.confidence).toEqual({ value: 0.8, method: 'source_trust', basis: 'direct account' });
    expect(Date.parse(observation.observedAt)).not.toBeNaN();
  });

  it('first outcome wins (outcome_conflict), and missing evidence is rejected', async () => {
    const ctx = member(tenantReads);
    const mission = await seedMission(ctx, { candidateSources: [{ kind: 'system', label: 'billing-export' }] });
    const plan = await planNextAcquisition(ctx, planInput(mission.id, [
      sig('system', { label: 'billing-export' }),
    ]));

    await recordAcquisitionOutcome(ctx, answer(plan.id));
    await expectCode('outcome_conflict', () =>
      recordAcquisitionOutcome(ctx, { planId: plan.id, outcome: 'failed', note: 'late failure' }),
    );
    // The first outcome stands.
    const read = await getAcquisitionPlan(ctx, plan.id);
    expect(read.outcome!.outcome).toBe('answered');
  });

  it('rejects evidence the observations contract rejects (invalid_evidence)', async () => {
    const ctx = member(tenantReads);
    const mission = await seedMission(ctx, { candidateSources: [{ kind: 'system', label: 'billing-export' }] });
    const plan = await planNextAcquisition(ctx, planInput(mission.id, [
      sig('system', { label: 'billing-export' }),
    ]));
    await expectCode('invalid_evidence', () =>
      recordAcquisitionOutcome(ctx, {
        planId: plan.id,
        outcome: 'answered',
        evidence: {
          payload: { answer: 'x' },
          confidence: { value: 0.5, method: 'NOT A SLUG' },
        },
      }),
    );
  });

  it('reports unknown, malformed and foreign-tenant plan ids as plan_not_found (no leak)', async () => {
    const ctx = member(tenantReads);
    await expectCode('plan_not_found', () =>
      recordAcquisitionOutcome(ctx, { planId: newId(), outcome: 'failed', note: 'x' }),
    );
    await expectCode('plan_not_found', () => getAcquisitionPlan(ctx, 'not-a-uuid'));
  });
});

// ---------------------------------------------------------------------------
// Append-only storage
// ---------------------------------------------------------------------------

describe('append-only storage (triggers reject mutation)', () => {
  it('rejects UPDATE/DELETE/TRUNCATE on plans and outcomes', async () => {
    const ctx = member(tenantReads);
    const mission = await seedMission(ctx, { candidateSources: [{ kind: 'system', label: 'billing-export' }] });
    const plan = await planNextAcquisition(ctx, planInput(mission.id, [
      sig('system', { label: 'billing-export' }),
    ]));
    await recordAcquisitionOutcome(ctx, answer(plan.id));

    await expect(getDb().query(`UPDATE acquisition_plans SET rationale = 'rewritten'`)).rejects.toThrow(/append-only/);
    await expect(getDb().query(`DELETE FROM acquisition_plans`)).rejects.toThrow(/append-only/);
    // TRUNCATE is rejected too — on plans the outcome FK fires first, on
    // outcomes the trigger itself does; either way the table cannot be
    // emptied.
    await expect(getDb().query(`TRUNCATE acquisition_plans`)).rejects.toThrow(/append-only|cannot truncate/);
    await expect(getDb().query(`UPDATE acquisition_outcomes SET note = 'rewritten'`)).rejects.toThrow(/append-only/);
    await expect(getDb().query(`DELETE FROM acquisition_outcomes`)).rejects.toThrow(/append-only/);
    await expect(getDb().query(`TRUNCATE acquisition_outcomes`)).rejects.toThrow(/append-only/);
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation
// ---------------------------------------------------------------------------

describe('tenant isolation (ADR-0001)', () => {
  it('never leaks another tenant\'s missions, plans or outcomes', async () => {
    const ctxA = member(tenantIso);
    const ctxB = member(tenantB);
    const vp = await askableEmployee(tenantIso, 'Isolated Ivy');
    const mission = await seedMission(ctxA, {
      candidateSources: [{ kind: 'person', id: vp.id }],
    });
    const plan = await planNextAcquisition(ctxA, planInput(mission.id, [
      sig('person', { id: vp.id }, {}, 0.9),
    ]));
    await recordAcquisitionOutcome(ctxA, answer(plan.id));

    // The mission, the plan and the outcome are invisible in tenant B.
    await expectCode('mission_not_found', () =>
      planNextAcquisition(ctxB, planInput(mission.id, [sig('person', { id: vp.id }, {}, 0.9)])),
    );
    await expectCode('plan_not_found', () => getAcquisitionPlan(ctxB, plan.id));
    await expectCode('plan_not_found', () =>
      recordAcquisitionOutcome(ctxB, { planId: plan.id, outcome: 'failed', note: 'cross-tenant write' }),
    );
    expect(await listAcquisitionPlans(ctxB, { missionId: mission.id })).toEqual([]);
    // And tenant A sees exactly its own plan.
    expect((await listAcquisitionPlans(ctxA, { missionId: mission.id })).map((p) => p.id)).toEqual([plan.id]);
  });

  it('lists stay tenant-scoped', async () => {
    const ctxA = member(tenantIso);
    const missionA = await seedMission(ctxA);
    await planNextAcquisition(ctxA, planInput(missionA.id, [])); // empty menu → no_candidate
    const ctxB = member(tenantB);
    const missionB = await seedMission(ctxB);
    await planNextAcquisition(ctxB, planInput(missionB.id, []));

    const plansA = await listAcquisitionPlans(ctxA, {});
    expect(plansA.every((plan) => plan.tenantId === tenantIso)).toBe(true);
    const plansB = await listAcquisitionPlans(ctxB, {});
    expect(plansB.every((plan) => plan.tenantId === tenantB)).toBe(true);
    expect(plansA.map((p) => p.missionId)).not.toContain(missionB.id);
  });
});

// ---------------------------------------------------------------------------
// Read surface
// ---------------------------------------------------------------------------

describe('reads (getAcquisitionPlan / listAcquisitionPlans)', () => {
  it('round-trips a plan and its outcome', async () => {
    const ctx = member(tenantReads);
    const vp = await askableEmployee(tenantReads, 'Roundtrip Rita');
    const mission = await seedMission(ctx, {
      candidateSources: [
        { kind: 'person', id: vp.id },
        { kind: 'system', label: 'billing-export' },
      ],
    });
    const plan = await planNextAcquisition(ctx, planInput(mission.id, [
      sig('person', { id: vp.id }, {}, 0.9),
      sig('system', { label: 'billing-export' }),
    ]));
    expect(await getAcquisitionPlan(ctx, plan.id)).toEqual(plan);

    const resolved = await recordAcquisitionOutcome(ctx, answer(plan.id));
    expect(await getAcquisitionPlan(ctx, plan.id)).toEqual(resolved);
  });

  it('filters by mission, decision and action, latest first', async () => {
    const ctx = member(tenantList);
    const vp = await askableEmployee(tenantList, 'Filter Fay');
    const missionOne = await seedMission(ctx, {
      candidateSources: [
        { kind: 'person', id: vp.id },
        { kind: 'system', label: 'billing-export' },
      ],
    });
    const missionTwo = await seedMission(ctx, {
      candidateSources: [{ kind: 'analysis', label: 'cohort model' }],
    });

    const ask = await planNextAcquisition(ctx, planInput(missionOne.id, [
      sig('person', { id: vp.id }, {}, 0.9),
      sig('system', { label: 'billing-export' }),
    ], 'first pass'));
    await recordAcquisitionOutcome(ctx, answer(ask.id));
    const query = await planNextAcquisition(ctx, planInput(missionOne.id, [
      sig('person', { id: vp.id }, {}, 0.9),
      sig('system', { label: 'billing-export' }),
    ], 'second pass'));
    const analysis = await planNextAcquisition(ctx, planInput(missionTwo.id, [
      sig('analysis', { label: 'cohort model' }),
    ]));

    const forMission = await listAcquisitionPlans(ctx, { missionId: missionOne.id });
    expect(forMission.map((plan) => plan.id)).toEqual([query.id, ask.id]); // latest first

    const selected = await listAcquisitionPlans(ctx, { decision: 'selected' });
    expect(selected.map((plan) => plan.id).sort()).toEqual([ask.id, query.id, analysis.id].sort());

    const asks = await listAcquisitionPlans(ctx, { action: 'ask-person' });
    expect(asks.map((plan) => plan.id)).toEqual([ask.id]);

    const all = await listAcquisitionPlans(ctx, {});
    expect(all).toHaveLength(3);
    for (let i = 1; i < all.length; i += 1) {
      const previous = all[i - 1]!;
      const current = all[i]!;
      expect(
        previous.recordedAt > current.recordedAt ||
          (previous.recordedAt === current.recordedAt && previous.id > current.id),
      ).toBe(true);
    }
    // The persisted rationale survived: signals + rationale text are readable.
    expect((await getAcquisitionPlan(ctx, query.id)).rationale).toBe('second pass');
    expect(rankedOf(query, 'person').exclusion).toBe('already_attempted');
  });

  it('rejects malformed queries', async () => {
    const ctx = member(tenantReads);
    await expectCode('invalid_query', () =>
      listAcquisitionPlans(ctx, { decision: 'maybe' as never }),
    );
    await expectCode('invalid_query', () => listAcquisitionPlans(ctx, { limit: 0 as never }));
  });
});
