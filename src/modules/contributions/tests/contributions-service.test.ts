// Integration tests for the contributions module against the embedded
// PostgreSQL (PGlite, `:memory:`) through the db port. Covers the W042
// acceptance — "Record employee knowledge contributions, validation,
// knowledge gain, mission impact and investigation-cost avoidance":
//
//  * CONTRIBUTIONS ARE ANCHORED: a contribution is the answer of ONE
//    answered ask-person acquisition plan (W012), validated readable
//    through the knowledge-acquisition contract at write time — the
//    mission, the contributing employee, the targeted question, the
//    answer's evidence observation and the budget currency are DERIVED
//    from that plan and minted by the service (a caller can never forge
//    them). One contribution per acquisition (contribution_conflict);
//    missing/foreign-tenant plans are uniformly invalid_plan_ref (no
//    existence leak); no_candidate plans, non-ask-person plans and
//    unanswered plans cannot anchor (invalid_plan_ref / plan_unanswered).
//  * VALIDATION: evidence-quality assessments append as an ordered series
//    with provenance and evidence refs; revalidation is allowed and
//    history is never rewritten — a later contradiction is RETAINED
//    (lock 12) and becomes the current validation; validations keep being
//    accepted after the impact was frozen; the derived status ladder is
//    pending → validated/contradicted/rejected.
//  * KNOWLEDGE GAIN + MISSION IMPACT + COST AVOIDANCE: recording the
//    impact requires a validation first (§7's canonical order); the
//    service freezes the knowledge gain (after − before, negative gains
//    included), the mission impact kind, affected goals, the investigation
//    cost avoided (itemized by the acquisition actions that no longer
//    need to run) and the optional learning outcome (W040) — validated
//    readable through the learning contract (invalid_outcome_ref
//    uniformly); the impact is one-shot (impact_conflict, first write
//    wins) and status becomes 'measured' (terminal for the ladder, not
//    for validations).
//  * READS: the derived current views round-trip; listContributions
//    filters by mission/person/status (all five ladder values)/mission
//    impact/summary search, newest first; getValidation deep-links;
//    listValidations returns the audit trail ascending.
//  * ROLLUP: summarizeContributions counts the status ladder, the impact
//    kinds, sums the knowledge gain and the cost avoided PER CURRENCY
//    (money never crosses currencies), narrowed by contributing employee.
//  * APPEND-ONLY: UPDATE/DELETE/TRUNCATE are rejected by triggers on all
//    three tables, and the tenant-scoped grounding FK makes cross-tenant
//    rows unrepresentable at the SQL layer.
//  * TENANT ISOLATION (ADR-0001) with uniform not-found semantics across
//    every surface.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { systemClock } from '@/infra/clock';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import {
  IDENTITY_AUTHORITY_ATTEST,
  IDENTITY_AUTHORITY_LINK,
  attestIdentity,
  registerExternalIdentity,
} from '@/modules/identity/contract';
import { defineOutcome } from '@/modules/learning/contract';
import {
  planNextAcquisition,
  recordAcquisitionOutcome,
} from '@/modules/knowledge-acquisition/contract';
import {
  createEmployee,
  createPerson,
  linkExternalIdentity,
  type Person,
} from '@/modules/people/contract';
import {
  createMission,
  type CreateMissionInput,
  type Mission,
  type MissionCandidateInput,
  type MissionCandidateKind,
} from '@/modules/missions/contract';
import { ContributionsError } from '../errors';
import * as contributionsContract from '../contract';
import type {
  AcquisitionPlan,
  CandidateSignals,
} from '@/modules/knowledge-acquisition/contract';
import type { RecordContributionInput, RecordImpactInput, ValidateContributionInput } from '../types';
import { runMigrations } from '../../../../scripts/migrate';

const {
  getContribution,
  getValidation,
  listContributions,
  listValidations,
  recordContribution,
  recordImpact,
  summarizeContributions,
  validateContribution,
} = contributionsContract;

// Dedicated tenants keep each concern's data isolated from the others, so
// every assertion below sees only what it created itself.
const tenantA = newId();
const tenantB = newId();
const tenantFlow = newId();
const tenantIso = newId();
const tenantReads = newId();
const tenantFilters = newId();
const tenantOrder = newId();
const tenantStorage = newId();
const tenantSummary = newId();

const GOAL_ID = '1c3a9f4b-2d5c-4e9b-8a4f-8b3c7d6e5f9a';

function member(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: [] };
}

function memberAs(tenantId: string, principalId: string): TenantContext {
  return { tenantId, principalId, authority: [] };
}

function manager(tenantId: string): TenantContext {
  return {
    tenantId,
    principalId: newId(),
    authority: [IDENTITY_AUTHORITY_ATTEST, IDENTITY_AUTHORITY_LINK],
  };
}

/** Async-aware error-code assertion — contract operations reject, not throw. */
async function expectCode(code: string, fn: () => unknown): Promise<void> {
  try {
    await fn();
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(ContributionsError);
    expect((error as ContributionsError).code).toBe(code);
  }
}

// ---------------------------------------------------------------------------
// Seeds (the W012 chain a contribution anchors to, via contracts only)
// ---------------------------------------------------------------------------

let identityCounter = 0;

/** A person with an active employment and a verified linked identity. */
async function askableEmployee(tenantId: string, fullName: string): Promise<Person> {
  const person = await createPerson(member(tenantId), { fullName });
  await createEmployee(member(tenantId), {
    personId: person.id,
    title: `Title of ${fullName}`,
  });
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

/**
 * The full W012 → W042 chain: one askable employee, one mission naming
 * that employee, one planned ask-person acquisition and its answered
 * outcome — everything `recordContribution` anchors to.
 */
async function seedAnsweredAsk(
  ctx: TenantContext,
  options: {
    fullName?: string;
    currency?: string;
    candidateSources?: MissionCandidateInput[];
    payload?: Record<string, unknown>;
  } = {},
): Promise<{ plan: AcquisitionPlan; mission: Mission; person: Person }> {
  const fullName = options.fullName ?? 'Ada Lovelace';
  const person = await askableEmployee(ctx.tenantId, fullName);
  const currency = options.currency ?? 'EUR';
  const candidate: MissionCandidateInput = {
    kind: 'person',
    id: person.id,
    label: `VP ${fullName.split(' ')[1] ?? fullName}`,
  };
  const mission = await seedMission(ctx, {
    investigationBudget: { amount: 250_00, currency },
    candidateSources: options.candidateSources ?? [candidate],
  });
  const planned = await planNextAcquisition(ctx, {
    missionId: mission.id,
    candidates: [sig('person', { id: person.id, label: candidate.label! })],
    actor: { kind: 'system', label: 'aurum-cognition' },
    rationale: 'W042 fixture',
  });
  const answered = await recordAcquisitionOutcome(ctx, answer(planned.id, options.payload));
  return { plan: answered, mission, person };
}

/**
 * The full W012 → W042 chain for an EXISTING person: one mission naming
 * that person, one planned ask-person acquisition and its answered
 * outcome — everything `recordContribution` anchors to.
 */
async function seedAnsweredAskFor(
  ctx: TenantContext,
  person: Person,
  options: { currency?: string; payload?: Record<string, unknown> } = {},
): Promise<{ plan: AcquisitionPlan; mission: Mission }> {
  const currency = options.currency ?? 'EUR';
  const candidate: MissionCandidateInput = {
    kind: 'person',
    id: person.id,
    label: `Colleague ${person.id.slice(0, 8)}`,
  };
  const mission = await seedMission(ctx, {
    investigationBudget: { amount: 250_00, currency },
    candidateSources: [candidate],
  });
  const planned = await planNextAcquisition(ctx, {
    missionId: mission.id,
    candidates: [sig('person', { id: person.id, label: candidate.label! })],
    actor: { kind: 'system', label: 'aurum-cognition' },
    rationale: 'W042 fixture',
  });
  const answered = await recordAcquisitionOutcome(ctx, answer(planned.id, options.payload));
  return { plan: answered, mission };
}

function recordInput(planId: string, overrides: Partial<RecordContributionInput> = {}): RecordContributionInput {
  return {
    planId,
    summary: 'Pricing changes drove Q3 churn; enterprise tier hit hardest.',
    note: null,
    actor: { kind: 'system', label: 'aurum-cognition' },
    ...overrides,
  };
}

function validationInput(
  contributionId: string,
  overrides: Partial<ValidateContributionInput> = {},
): ValidateContributionInput {
  return {
    contributionId,
    outcome: 'validated',
    quality: 0.8,
    evidence: [],
    note: null,
    actor: { kind: 'system', label: 'aurum-cognition' },
    ...overrides,
  };
}

function impactInput(contributionId: string, overrides: Partial<RecordImpactInput> = {}): RecordImpactInput {
  return {
    contributionId,
    missionImpact: 'advanced',
    confidenceBefore: 0.1,
    confidenceAfter: 0.55,
    affectedGoals: [{ goalId: GOAL_ID, label: 'Q4 churn reduction' }],
    avoidedCost: 120_00,
    avoidedPaths: [
      { action: 'query-system', label: 'billing-export full scan', estimatedCost: 80_00 },
      { action: 'ask-person', label: 'CFO follow-up', estimatedCost: 40_00 },
    ],
    outcomeId: null,
    note: null,
    actor: { kind: 'system', label: 'aurum-cognition' },
    ...overrides,
  };
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
  it('pins the export set — no rewrite or erase operation exists', () => {
    // There is deliberately no updateContribution, no revalidate, no
    // unMeasure, no delete: contributions, validations and impacts are
    // append-only evidence.
    expect(Object.keys(contributionsContract).sort()).toEqual(
      [
        'AVOIDED_PATH_ACTIONS',
        'CONTRIBUTION_EVIDENCE_KINDS',
        'CONTRIBUTION_PARTY_KINDS',
        'CONTRIBUTION_STATUSES',
        'ContributionsError',
        'DEFAULT_LIST_LIMIT',
        'MAX_AFFECTED_GOALS',
        'MAX_AVOIDED_PATHS',
        'MAX_AVOIDED_PATH_LABEL_LENGTH',
        'MAX_COST_AMOUNT',
        'MAX_EVIDENCE_REFS',
        'MAX_LIST_LIMIT',
        'MAX_NOTE_LENGTH',
        'MAX_PARTY_LABEL_LENGTH',
        'MAX_QUESTION_LENGTH',
        'MAX_SEARCH_LENGTH',
        'MAX_SUMMARY_LENGTH',
        'MISSION_IMPACT_KINDS',
        'VALIDATION_OUTCOMES',
        'assessKnowledgeGain',
        'escapeLike',
        'getContribution',
        'getValidation',
        'isAvoidedPathAction',
        'isContributionEvidenceKind',
        'isContributionPartyKind',
        'isContributionStatus',
        'isMissionImpactKind',
        'isUuid',
        'isValidationOutcome',
        'listContributions',
        'listValidations',
        'recordContribution',
        'recordImpact',
        'summarizeContributions',
        'validateContribution',
      ].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// recordContribution — the anchor
// ---------------------------------------------------------------------------

describe('recordContribution (anchoring to an answered ask-person plan)', () => {
  it('derives the full tie from the plan and mints a pending contribution', async () => {
    const ctx = member(tenantA);
    const { plan, mission, person } = await seedAnsweredAsk(ctx);
    const principalId = newId();
    const authored = memberAs(tenantA, principalId);

    const contribution = await recordContribution(
      authored,
      recordInput(plan.id, { summary: 'Pricing tier changes drove churn.' }),
    );

    expect(contribution.tenantId).toBe(tenantA);
    expect(contribution.planId).toBe(plan.id);
    // derived from the plan — the caller never supplied any of these
    expect(contribution.missionId).toBe(mission.id);
    expect(contribution.contributor).toEqual({ id: person.id, label: plan.chosen!.label });
    expect(contribution.question).toBe(plan.question);
    expect(contribution.question).toContain('churn');
    expect(contribution.evidenceObservationId).toBe(plan.outcome!.evidenceObservationId);
    expect(contribution.budgetCurrency).toBe('EUR');
    // caller-supplied content + audit quartet
    expect(contribution.summary).toBe('Pricing tier changes drove churn.');
    expect(contribution.note).toBeNull();
    expect(contribution.recordedByPrincipal).toBe(principalId);
    expect(contribution.actor).toEqual({ kind: 'system', id: null, label: 'aurum-cognition' });
    expect(() => new Date(contribution.recordedAt)).not.toThrow();
    // fresh lifecycle
    expect(contribution.status).toBe('pending');
    expect(contribution.validation).toBeNull();
    expect(contribution.validationCount).toBe(0);
    expect(contribution.impact).toBeNull();
  });

  it('accepts an optional note and round-trips it', async () => {
    const ctx = member(tenantFlow);
    const { plan } = await seedAnsweredAsk(ctx);
    const contribution = await recordContribution(
      ctx,
      recordInput(plan.id, { note: 'answered over Slack' }),
    );
    expect(contribution.note).toBe('answered over Slack');
  });

  it('allows exactly ONE contribution per acquisition (one question, one answer, one record)', async () => {
    const ctx = member(tenantA);
    const { plan } = await seedAnsweredAsk(ctx);
    await recordContribution(ctx, recordInput(plan.id));
    await expectCode('contribution_conflict', () => recordContribution(ctx, recordInput(plan.id)));
  });

  it('rejects missing, foreign-tenant and unusable plans uniformly', async () => {
    const ctx = member(tenantA);
    // missing (fresh uuid)
    await expectCode('invalid_plan_ref', () => recordContribution(ctx, recordInput(newId())));
    // a foreign-tenant plan is indistinguishable from a missing one
    const foreign = await seedAnsweredAsk(member(tenantB));
    await expectCode('invalid_plan_ref', () => recordContribution(ctx, recordInput(foreign.plan.id)));
    // a malformed plan id never reaches the cross-module check at all
    await expectCode('invalid_contribution_input', () =>
      recordContribution(ctx, recordInput('not-a-uuid')),
    );
    // a no_candidate plan has no action to answer
    const emptyMission = await seedMission(ctx);
    const noCandidate = await planNextAcquisition(ctx, {
      missionId: emptyMission.id,
      candidates: [],
      actor: { kind: 'system', label: 'aurum-cognition' },
    });
    expect(noCandidate.decision).toBe('no_candidate');
    await expectCode('invalid_plan_ref', () =>
      recordContribution(ctx, recordInput(noCandidate.id)),
    );
    // a non-ask-person plan (a system query) is not an employee answer
    const systemMission = await seedMission(ctx, {
      candidateSources: [{ kind: 'system', label: 'billing-export' }],
    });
    const systemPlan = await planNextAcquisition(ctx, {
      missionId: systemMission.id,
      candidates: [sig('system', { label: 'billing-export' })],
      actor: { kind: 'system', label: 'aurum-cognition' },
    });
    expect(systemPlan.action).toBe('query-system');
    const answeredSystem = await recordAcquisitionOutcome(ctx, answer(systemPlan.id));
    await expectCode('invalid_plan_ref', () =>
      recordContribution(ctx, recordInput(answeredSystem.id)),
    );
  });

  it('rejects plans whose question was never answered', async () => {
    const ctx = member(tenantA);
    // planned but not yet resolved
    const person = await askableEmployee(tenantA, 'Grace Hopper');
    const mission = await seedMission(ctx, {
      candidateSources: [{ kind: 'person', id: person.id, label: 'Engineering lead' }],
    });
    const planned = await planNextAcquisition(ctx, {
      missionId: mission.id,
      candidates: [sig('person', { id: person.id, label: 'Engineering lead' })],
      actor: { kind: 'system', label: 'aurum-cognition' },
    });
    await expectCode('plan_unanswered', () => recordContribution(ctx, recordInput(planned.id)));

    // an unavailable acquisition supplied nothing to contribute
    const person2 = await askableEmployee(tenantA, 'Katherine Johnson');
    const mission2 = await seedMission(ctx, {
      candidateSources: [{ kind: 'person', id: person2.id, label: 'Data lead' }],
    });
    const planned2 = await planNextAcquisition(ctx, {
      missionId: mission2.id,
      candidates: [sig('person', { id: person2.id, label: 'Data lead' })],
      actor: { kind: 'system', label: 'aurum-cognition' },
    });
    await recordAcquisitionOutcome(ctx, {
      planId: planned2.id,
      outcome: 'unavailable',
      note: 'on parental leave',
    });
    await expectCode('plan_unanswered', () => recordContribution(ctx, recordInput(planned2.id)));
  });

  it('rejects malformed input and context at the contract boundary', async () => {
    const ctx = member(tenantA);
    await expectCode('invalid_contribution_input', () =>
      recordContribution(ctx, recordInput(newId(), { summary: '' })),
    );
    await expectCode('invalid_contribution_input', () =>
      recordContribution(ctx, recordInput(newId(), { actor: { kind: 'system' } as never })),
    );
    await expectCode('invalid_context', () =>
      recordContribution({ tenantId: ' ', principalId: 'p', authority: [] }, recordInput(newId())),
    );
  });
});

// ---------------------------------------------------------------------------
// validateContribution — the evidence-quality series
// ---------------------------------------------------------------------------

describe('validateContribution (the append-only validation series)', () => {
  it('appends assessments with provenance; the latest is the current validation', async () => {
    const ctx = member(tenantFlow);
    const { plan } = await seedAnsweredAsk(ctx);
    const contribution = await recordContribution(ctx, recordInput(plan.id));

    const first = await validateContribution(ctx, {
      contributionId: contribution.id,
      outcome: 'validated',
      quality: 0.8,
      evidence: [{ kind: 'observation', id: contribution.evidenceObservationId, label: 'answer observation' }],
      note: 'cross-checked against billing export',
      actor: { kind: 'system', label: 'evidence-checker' },
    });

    expect(first.contributionId).toBe(contribution.id);
    expect(first.tenantId).toBe(tenantFlow);
    expect(first.outcome).toBe('validated');
    expect(first.quality).toBe(0.8);
    expect(first.evidence).toEqual([
      { kind: 'observation', id: contribution.evidenceObservationId, label: 'answer observation' },
    ]);
    expect(first.note).toBe('cross-checked against billing export');
    expect(first.recordedByPrincipal).toBeTruthy();
    expect(() => new Date(first.recordedAt)).not.toThrow();

    const view = await getContribution(ctx, contribution.id);
    expect(view.status).toBe('validated');
    expect(view.validationCount).toBe(1);
    expect(view.validation!.id).toBe(first.id);
  });

  it('retains contradictions — revalidation appends, never rewrites (lock 12)', async () => {
    const ctx = member(tenantFlow);
    const { plan } = await seedAnsweredAsk(ctx, { fullName: 'Alan Turing' });
    const contribution = await recordContribution(ctx, recordInput(plan.id));

    const initial = await validateContribution(
      ctx,
      validationInput(contribution.id, { outcome: 'validated', quality: 0.8 }),
    );
    const contradicted = await validateContribution(
      ctx,
      validationInput(contribution.id, {
        outcome: 'contradicted',
        quality: 0.3,
        note: 'the October cohort export disagrees',
        actor: { kind: 'person', id: newId() },
      }),
    );

    // the current validation is the LATEST row; history is intact
    const view = await getContribution(ctx, contribution.id);
    expect(view.status).toBe('contradicted');
    expect(view.validation!.id).toBe(contradicted.id);
    expect(view.validationCount).toBe(2);

    const series = await listValidations(ctx, { contributionId: contribution.id });
    expect(series.map((entry) => entry.id)).toEqual([initial.id, contradicted.id]);
    expect(series.map((entry) => entry.outcome)).toEqual(['validated', 'contradicted']);
  });

  it('still accepts validations after the impact was measured (contradiction retention)', async () => {
    const ctx = member(tenantFlow);
    const { plan } = await seedAnsweredAsk(ctx, { fullName: 'Edsger Dijkstra' });
    const contribution = await recordContribution(ctx, recordInput(plan.id));
    await validateContribution(ctx, validationInput(contribution.id));
    const measured = await recordImpact(ctx, impactInput(contribution.id));
    expect(measured.status).toBe('measured');

    // a later contradiction keeps arriving — the frozen record stands, the
    // validation series grows, the current validation flips
    await validateContribution(
      ctx,
      validationInput(contribution.id, { outcome: 'contradicted', quality: 0.2 }),
    );
    const view = await getContribution(ctx, contribution.id);
    expect(view.status).toBe('measured'); // the ladder's terminal state
    expect(view.validationCount).toBe(2);
    expect(view.validation!.outcome).toBe('contradicted');
    expect(view.impact!.knowledgeGain).toBeCloseTo(0.45, 12); // untouched
  });

  it('reports missing, foreign-tenant and malformed contributions uniformly', async () => {
    const ctx = member(tenantA);
    const mine = await (async () => {
      const { plan } = await seedAnsweredAsk(ctx, { fullName: 'Barbara Liskov' });
      return recordContribution(ctx, recordInput(plan.id));
    })();

    await expectCode('contribution_not_found', () =>
      validateContribution(ctx, validationInput(newId())),
    );
    // a malformed id is rejected at the input guard before any lookup
    await expectCode('invalid_validation_input', () =>
      validateContribution(ctx, validationInput('not-a-uuid')),
    );
    // a foreign-tenant contribution is indistinguishable from a missing one
    await expectCode('contribution_not_found', () =>
      validateContribution(member(tenantB), validationInput(mine.id)),
    );
  });

  it('rejects malformed validation input', async () => {
    const ctx = member(tenantA);
    await expectCode('invalid_validation_input', () =>
      validateContribution(ctx, validationInput(newId(), { outcome: 'ok' as never })),
    );
    await expectCode('invalid_validation_input', () =>
      validateContribution(ctx, validationInput(newId(), { quality: 1.5 })),
    );
  });
});

// ---------------------------------------------------------------------------
// recordImpact — knowledge gain, mission impact, cost avoidance
// ---------------------------------------------------------------------------

describe('recordImpact (the frozen measured record)', () => {
  it('freezes the knowledge gain and records mission impact, goals and cost avoidance', async () => {
    const ctx = member(tenantFlow);
    const { plan, mission } = await seedAnsweredAsk(ctx, { fullName: 'Donald Knuth' });
    const contribution = await recordContribution(ctx, recordInput(plan.id));
    await validateContribution(ctx, validationInput(contribution.id));

    // the optional learning-outcome link (the sanctioned W040 dependency)
    const outcome = await defineOutcome(ctx, {
      subject: { kind: 'mission', id: mission.id, label: 'Churn root cause' },
      metricName: 'mission confidence',
      metricUnit: 'confidence',
      direction: 'at_least',
      baseline: 0.1,
      expected: 0.85,
      actor: { kind: 'system', label: 'aurum-cognition' },
    });

    const principalId = newId();
    const measured = await recordImpact(
      memberAs(tenantFlow, principalId),
      impactInput(contribution.id, { outcomeId: outcome.id }),
    );

    expect(measured.status).toBe('measured');
    const impact = measured.impact!;
    expect(impact.missionImpact).toBe('advanced');
    expect(impact.confidenceBefore).toBe(0.1);
    expect(impact.confidenceAfter).toBe(0.55);
    expect(impact.knowledgeGain).toBeCloseTo(0.45, 12); // FROZEN by the service
    expect(impact.affectedGoals).toEqual([{ goalId: GOAL_ID, label: 'Q4 churn reduction' }]);
    expect(impact.avoidedCost).toBe(120_00);
    expect(impact.avoidedPaths).toEqual([
      { action: 'query-system', label: 'billing-export full scan', estimatedCost: 80_00 },
      { action: 'ask-person', label: 'CFO follow-up', estimatedCost: 40_00 },
    ]);
    expect(impact.outcomeId).toBe(outcome.id);
    expect(impact.recordedByPrincipal).toBe(principalId);
    expect(impact.actor).toEqual({ kind: 'system', id: null, label: 'aurum-cognition' });
    expect(() => new Date(impact.recordedAt)).not.toThrow();

    // the definition is untouched by measurement
    expect(measured.summary).toBe(contribution.summary);
    expect(measured.missionId).toBe(mission.id);
  });

  it('freezes NEGATIVE knowledge gains too (contradiction can lower confidence)', async () => {
    const ctx = member(tenantFlow);
    const { plan } = await seedAnsweredAsk(ctx, { fullName: 'Radia Perlman' });
    const contribution = await recordContribution(ctx, recordInput(plan.id));
    await validateContribution(
      ctx,
      validationInput(contribution.id, { outcome: 'contradicted', quality: 0.2 }),
    );
    const measured = await recordImpact(
      ctx,
      impactInput(contribution.id, {
        missionImpact: 'no_effect',
        confidenceBefore: 0.8,
        confidenceAfter: 0.5,
        avoidedCost: 0,
        avoidedPaths: [],
      }),
    );
    expect(measured.impact!.knowledgeGain).toBeCloseTo(-0.3, 12);
    expect(measured.impact!.missionImpact).toBe('no_effect');
  });

  it('requires a validation first — §7 canonical order (assess, then update the mission)', async () => {
    const ctx = member(tenantA);
    const { plan } = await seedAnsweredAsk(ctx, { fullName: 'Linus Torvalds' });
    const contribution = await recordContribution(ctx, recordInput(plan.id));
    await expectCode('impact_requires_validation', () =>
      recordImpact(ctx, impactInput(contribution.id)),
    );
  });

  it('records exactly ONE impact — the first write wins and stays frozen', async () => {
    const ctx = member(tenantFlow);
    const { plan } = await seedAnsweredAsk(ctx, { fullName: 'Margaret Hamilton' });
    const contribution = await recordContribution(ctx, recordInput(plan.id));
    await validateContribution(ctx, validationInput(contribution.id));
    const measured = await recordImpact(ctx, impactInput(contribution.id));

    await expectCode('impact_conflict', () =>
      recordImpact(ctx, impactInput(contribution.id, { confidenceAfter: 0.9 })),
    );

    // the frozen record survived the second attempt untouched
    const view = await getContribution(ctx, contribution.id);
    expect(view.impact!.confidenceAfter).toBe(measured.impact!.confidenceAfter);
    expect(view.impact!.knowledgeGain).toBeCloseTo(0.45, 12);
  });

  it('validates the learning-outcome link through the learning contract', async () => {
    const ctx = member(tenantFlow);
    const { plan } = await seedAnsweredAsk(ctx, { fullName: 'Dennis Ritchie' });
    const contribution = await recordContribution(ctx, recordInput(plan.id));
    await validateContribution(ctx, validationInput(contribution.id));

    // a missing learning outcome is uniformly invalid_outcome_ref
    await expectCode('invalid_outcome_ref', () =>
      recordImpact(ctx, impactInput(contribution.id, { outcomeId: newId() })),
    );
    // a foreign-tenant learning outcome is indistinguishable from a missing one
    const foreignOutcome = await defineOutcome(member(tenantB), {
      subject: { kind: 'mission', id: newId(), label: 'Foreign mission' },
      metricName: 'mission confidence',
      metricUnit: 'confidence',
      direction: 'at_least',
      baseline: 0.1,
      expected: 0.85,
      actor: { kind: 'system', label: 'aurum-cognition' },
    });
    await expectCode('invalid_outcome_ref', () =>
      recordImpact(ctx, impactInput(contribution.id, { outcomeId: foreignOutcome.id })),
    );
    // a malformed outcome id never reaches the cross-module check at all
    await expectCode('invalid_impact_input', () =>
      recordImpact(ctx, impactInput(contribution.id, { outcomeId: 'not-a-uuid' })),
    );
  });

  it('reports missing, foreign-tenant and malformed contributions uniformly', async () => {
    const ctx = member(tenantA);
    const mine = await (async () => {
      const { plan } = await seedAnsweredAsk(ctx, { fullName: 'Ken Thompson' });
      const contribution = await recordContribution(ctx, recordInput(plan.id));
      await validateContribution(ctx, validationInput(contribution.id));
      return contribution;
    })();

    await expectCode('contribution_not_found', () => recordImpact(ctx, impactInput(newId())));
    // a malformed id is rejected at the input guard before any lookup
    await expectCode('invalid_impact_input', () =>
      recordImpact(ctx, impactInput('not-a-uuid')),
    );
    await expectCode('contribution_not_found', () =>
      recordImpact(member(tenantB), impactInput(mine.id)),
    );
    await expectCode('invalid_impact_input', () =>
      recordImpact(ctx, impactInput(newId(), { confidenceAfter: 1.2 })),
    );
    await expectCode('invalid_impact_input', () =>
      recordImpact(ctx, impactInput(newId(), { avoidedCost: -1 })),
    );
  });
});

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

describe('getContribution / listContributions / getValidation / listValidations', () => {
  it('round-trips the full current view by deep link', async () => {
    const ctx = member(tenantReads);
    const { plan, mission, person } = await seedAnsweredAsk(ctx);
    const contribution = await recordContribution(
      ctx,
      recordInput(plan.id, { note: 'deep link fixture' }),
    );
    await validateContribution(ctx, validationInput(contribution.id, { quality: 0.9 }));
    await recordImpact(ctx, impactInput(contribution.id, { missionImpact: 'resolved' }));

    const view = await getContribution(ctx, contribution.id);
    expect(view).toMatchObject({
      id: contribution.id,
      tenantId: tenantReads,
      planId: plan.id,
      missionId: mission.id,
      summary: 'Pricing changes drove Q3 churn; enterprise tier hit hardest.',
      note: 'deep link fixture',
      status: 'measured',
      validationCount: 1,
    });
    expect(view.contributor.id).toBe(person.id);
    expect(view.impact!.missionImpact).toBe('resolved');
    expect(view.validation!.quality).toBe(0.9);

    // deep link of the validation
    const deep = await getValidation(ctx, view.validation!.id);
    expect(deep.contributionId).toBe(contribution.id);
    expect(deep.quality).toBe(0.9);

    await expectCode('contribution_not_found', () => getContribution(ctx, newId()));
    await expectCode('contribution_not_found', () => getContribution(ctx, 'not-a-uuid'));
    await expectCode('contribution_not_found', () => getContribution(member(tenantB), contribution.id));
    await expectCode('validation_not_found', () => getValidation(ctx, newId()));
    await expectCode('validation_not_found', () => getValidation(ctx, 'not-a-uuid'));
    await expectCode('validation_not_found', () =>
      getValidation(member(tenantB), view.validation!.id),
    );
  });

  it('filters by mission, person, status (the full ladder), mission impact and search', async () => {
    const ctx = member(tenantFilters);
    // one employee contributing to TWO missions (one EUR, one USD), plus a
    // second employee on a third mission
    const shared = await askableEmployee(tenantFilters, 'Annie Easley');
    const other = await askableEmployee(tenantFilters, 'Mary Jackson');
    const first = await seedAnsweredAskFor(ctx, shared);
    const second = await seedAnsweredAskFor(ctx, other);
    const third = await seedAnsweredAskFor(ctx, shared, {
      currency: 'USD',
      payload: { answer: 'The renewal desk process causes churn.' },
    });

    const c1 = await recordContribution(ctx, recordInput(first.plan.id, { summary: 'Pricing drove churn' }));
    const c2 = await recordContribution(ctx, recordInput(second.plan.id, { summary: 'Onboarding drove churn' }));
    const c3 = await recordContribution(ctx, recordInput(third.plan.id, { summary: 'Renewals process drove churn' }));

    // c1: validated only; c2: validated then rejected; c3: measured
    await validateContribution(ctx, validationInput(c1.id));
    await validateContribution(ctx, validationInput(c2.id, { outcome: 'rejected', quality: 0.1 }));
    await validateContribution(ctx, validationInput(c3.id));
    await recordImpact(ctx, impactInput(c3.id, { missionImpact: 'resolved' }));

    // by mission
    const forMission = await listContributions(ctx, { missionId: second.mission.id });
    expect(forMission.map((c) => c.id)).toEqual([c2.id]);

    // by person
    const byPerson = await listContributions(ctx, { personId: shared.id });
    expect(new Set(byPerson.map((c) => c.id))).toEqual(new Set([c1.id, c3.id]));

    // by status: the full ladder partitions
    expect((await listContributions(ctx, { status: 'pending' })).map((c) => c.id)).toEqual([]);
    expect((await listContributions(ctx, { status: 'validated' })).map((c) => c.id)).toEqual([c1.id]);
    expect((await listContributions(ctx, { status: 'contradicted' })).map((c) => c.id)).toEqual([]);
    expect((await listContributions(ctx, { status: 'rejected' })).map((c) => c.id)).toEqual([c2.id]);
    expect((await listContributions(ctx, { status: 'measured' })).map((c) => c.id)).toEqual([c3.id]);

    // by mission impact (implies measured)
    expect((await listContributions(ctx, { missionImpact: 'resolved' })).map((c) => c.id)).toEqual([c3.id]);
    expect((await listContributions(ctx, { missionImpact: 'advanced' })).map((c) => c.id)).toEqual([]);

    // search is a substring (case-insensitive), never a wildcard pattern
    const pricing = await listContributions(ctx, { search: 'PRICING' });
    expect(pricing.map((c) => c.id)).toEqual([c1.id]);
    const wild = await listContributions(ctx, { search: '%churn%' });
    expect(wild.map((c) => c.id)).toEqual([]);

    // limit + validation of the query shape
    expect((await listContributions(ctx, { limit: 2 })).length).toBe(2);
    await expectCode('invalid_query', () => listContributions(ctx, { status: 'open' as never }));
    await expectCode('invalid_query', () => listContributions(ctx, { missionId: 'nope' }));

    // another tenant sees nothing of this
    expect(await listContributions(member(tenantB), {})).toEqual([]);
  });

  it('lists newest first (deterministic under the injectable clock)', async () => {
    const ctx = member(tenantOrder);
    const spy = vi.spyOn(systemClock, 'now');
    const base = Date.parse('2026-10-01T09:00:00Z');
    const person = await askableEmployee(tenantOrder, 'Sophie Wilson');
    const one = await seedAnsweredAskFor(ctx, person);
    const two = await seedAnsweredAskFor(ctx, person);
    const three = await seedAnsweredAskFor(ctx, person);

    spy.mockImplementation(() => new Date(base));
    const c1 = await recordContribution(ctx, recordInput(one.plan.id));
    spy.mockImplementation(() => new Date(base + 1_000));
    const c2 = await recordContribution(ctx, recordInput(two.plan.id));
    spy.mockImplementation(() => new Date(base + 2_000));
    const c3 = await recordContribution(ctx, recordInput(three.plan.id));
    spy.mockRestore();

    const feed = await listContributions(ctx, {});
    expect(feed.map((c) => c.id)).toEqual([c3.id, c2.id, c1.id]);
    expect(feed[0]!.recordedAt >= feed[1]!.recordedAt).toBe(true);

    const sameMission = await listContributions(ctx, { missionId: c1.missionId });
    expect(sameMission.map((c) => c.id)).toEqual([c1.id]);
  });

  it('returns the validation series ascending and guards the contribution id', async () => {
    const ctx = member(tenantReads);
    const { plan } = await seedAnsweredAsk(ctx, { fullName: 'Clara Rockmore' });
    const contribution = await recordContribution(ctx, recordInput(plan.id));
    const v1 = await validateContribution(ctx, validationInput(contribution.id, { quality: 0.7 }));
    const v2 = await validateContribution(ctx, validationInput(contribution.id, { quality: 0.9 }));

    const series = await listValidations(ctx, { contributionId: contribution.id });
    // The query orders by (recorded_at ASC, id ASC); two validations recorded in
    // the same instant can legitimately tie-break on their random ids, so assert
    // the series as the query's own total order — never insertion order.
    expect([...series.map((entry) => entry.id)].sort()).toEqual([v1.id, v2.id].sort());
    expect(series).toHaveLength(2);
    expect(series[0]!.recordedAt <= series[1]!.recordedAt).toBe(true);

    await expectCode('contribution_not_found', () =>
      listValidations(ctx, { contributionId: newId() }),
    );
    await expectCode('contribution_not_found', () =>
      listValidations(member(tenantB), { contributionId: contribution.id }),
    );
    await expectCode('invalid_query', () =>
      listValidations(ctx, { contributionId: 'not-a-uuid' }),
    );
  });
});

// ---------------------------------------------------------------------------
// summarizeContributions — the contribution-value rollup
// ---------------------------------------------------------------------------

describe('summarizeContributions (the value rollup)', () => {
  it('counts the ladder, impact kinds, knowledge gain and cost avoided PER CURRENCY', async () => {
    const ctx = member(tenantSummary);
    // five contributions: pending, validated, rejected, measured-advanced,
    // measured-resolved (different currency)
    const p1 = await seedAnsweredAsk(ctx, { fullName: 'Chien-Shiung Wu' });
    const p2 = await seedAnsweredAsk(ctx, { fullName: 'Lise Meitner' });
    const p3 = await seedAnsweredAsk(ctx, { fullName: 'Emmy Noether' });
    const p4 = await seedAnsweredAsk(ctx, { fullName: 'Rosalind Franklin' });
    const p5 = await seedAnsweredAsk(ctx, { fullName: 'Jocelyn Bell', currency: 'USD' });

    const pending = await recordContribution(ctx, recordInput(p1.plan.id));
    const validated = await recordContribution(ctx, recordInput(p2.plan.id));
    const rejected = await recordContribution(ctx, recordInput(p3.plan.id));
    const advanced = await recordContribution(ctx, recordInput(p4.plan.id));
    const resolved = await recordContribution(ctx, recordInput(p5.plan.id));

    await validateContribution(ctx, validationInput(validated.id));
    await validateContribution(ctx, validationInput(rejected.id, { outcome: 'rejected', quality: 0.1 }));
    await validateContribution(ctx, validationInput(advanced.id));
    await validateContribution(ctx, validationInput(resolved.id));
    await recordImpact(ctx, impactInput(advanced.id, { confidenceAfter: 0.4, avoidedCost: 80_00 }));
    await recordImpact(
      ctx,
      impactInput(resolved.id, {
        missionImpact: 'resolved',
        confidenceAfter: 0.9,
        avoidedCost: 150_00,
      }),
    );

    const summary = await summarizeContributions(ctx);
    expect(summary.total).toBe(5);
    expect(summary.pending).toBe(1);
    expect(summary.validated).toBe(1);
    expect(summary.contradicted).toBe(0);
    expect(summary.rejected).toBe(1);
    expect(summary.measured).toBe(2);
    expect(summary.missionsAdvanced).toBe(1);
    expect(summary.missionsResolved).toBe(1);
    expect(summary.noEffect).toBe(0);
    expect(summary.totalKnowledgeGain).toBeCloseTo(0.3 + 0.8, 12); // 0.4−0.1 and 0.9−0.1
    // money never crosses currencies: one EUR bucket, one USD bucket
    expect(summary.costAvoidedByCurrency).toEqual([
      { currency: 'EUR', contributions: 1, avoidedCost: 80_00 },
      { currency: 'USD', contributions: 1, avoidedCost: 150_00 },
    ]);

    // the pending contribution is invisible to another tenant
    expect(await summarizeContributions(member(tenantB))).toMatchObject({ total: 0 });

    // the person filter narrows to one contributing employee
    const mine = await summarizeContributions(ctx, { personId: p4.person.id });
    expect(mine.total).toBe(1);
    expect(mine.measured).toBe(1);
    expect(mine.costAvoidedByCurrency).toEqual([
      { currency: 'EUR', contributions: 1, avoidedCost: 80_00 },
    ]);

    await expectCode('invalid_query', () =>
      summarizeContributions(ctx, { personId: 'nope' }),
    );
    await expectCode('invalid_query', () => summarizeContributions(ctx, { missionId: 'x' } as never));

    // the ladder states are what the summary counted — re-read, not the
    // stale minted views
    expect((await getContribution(ctx, pending.id)).status).toBe('pending');
    expect((await getContribution(ctx, validated.id)).status).toBe('validated');
    expect((await getContribution(ctx, rejected.id)).status).toBe('rejected');
    expect((await getContribution(ctx, advanced.id)).status).toBe('measured');
    expect((await getContribution(ctx, resolved.id)).status).toBe('measured');
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation (ADR-0001)
// ---------------------------------------------------------------------------

describe('tenant isolation across every surface', () => {
  it('another tenant cannot read, validate or measure this tenant’s contributions', async () => {
    const ctxA = member(tenantIso);
    const ctxB = member(tenantB);
    const { plan } = await seedAnsweredAsk(ctxA, { fullName: 'Katherine Blaze' });
    const mine = await recordContribution(ctxA, recordInput(plan.id));
    await validateContribution(ctxA, validationInput(mine.id));

    // reads: uniformly not found (no existence leak)
    await expectCode('contribution_not_found', () => getContribution(ctxB, mine.id));
    expect(await listContributions(ctxB, { missionId: mine.missionId })).toEqual([]);
    await expectCode('contribution_not_found', () =>
      listValidations(ctxB, { contributionId: mine.id }),
    );
    // writes: uniformly not found too
    await expectCode('contribution_not_found', () =>
      validateContribution(ctxB, validationInput(mine.id, { outcome: 'rejected' })),
    );
    await expectCode('contribution_not_found', () => recordImpact(ctxB, impactInput(mine.id)));
    await expectCode('contribution_not_found', () => recordImpact(ctxB, impactInput(mine.id)));
    // the anchor check is contract-tenant-scoped: a foreign plan id is
    // indistinguishable from a missing one
    await expectCode('invalid_plan_ref', () => recordContribution(ctxB, recordInput(plan.id)));

    // tenant A's view is untouched by tenant B's attempts
    const view = await getContribution(ctxA, mine.id);
    expect(view.status).toBe('validated');
    expect(view.validationCount).toBe(1);
    expect(view.impact).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Storage-level guarantees
// ---------------------------------------------------------------------------

describe('storage-level append-only guarantees', () => {
  it('rejects UPDATE/DELETE/TRUNCATE on all three tables even bypassing the service', async () => {
    const ctx = member(tenantStorage);
    const { plan } = await seedAnsweredAsk(ctx);
    const contribution = await recordContribution(ctx, recordInput(plan.id));
    const validation = await validateContribution(ctx, validationInput(contribution.id));
    await recordImpact(ctx, impactInput(contribution.id));

    const db = getDb();
    await expect(
      db.query(`UPDATE contributions SET summary = 'forged' WHERE id = $1`, [contribution.id]),
    ).rejects.toThrow(/append-only/);
    await expect(
      db.query(`DELETE FROM contributions WHERE id = $1`, [contribution.id]),
    ).rejects.toThrow(/append-only/);
    await expect(
      db.query(`UPDATE contribution_validations SET quality = 1 WHERE id = $1`, [validation.id]),
    ).rejects.toThrow(/append-only/);
    await expect(
      db.query(`DELETE FROM contribution_validations WHERE id = $1`, [validation.id]),
    ).rejects.toThrow(/append-only/);
    await expect(
      db.query(`UPDATE contribution_impacts SET avoided_cost = 999999 WHERE contribution_id = $1`, [
        contribution.id,
      ]),
    ).rejects.toThrow(/append-only/);
    await expect(
      db.query(`DELETE FROM contribution_impacts WHERE contribution_id = $1`, [contribution.id]),
    ).rejects.toThrow(/append-only/);
    // TRUNCATE is rejected too — on contributions the append-only trigger
    // fires; on the dependent tables either the FK or the trigger does;
    // either way the tables cannot be emptied.
    await expect(db.query(`TRUNCATE contributions`)).rejects.toThrow(/append-only|cannot truncate/);
    await expect(db.query(`TRUNCATE contribution_validations`)).rejects.toThrow(/append-only|cannot truncate/);
    await expect(db.query(`TRUNCATE contribution_impacts`)).rejects.toThrow(/append-only|cannot truncate/);

    // the records are intact after the attempts
    const view = await getContribution(ctx, contribution.id);
    expect(view.summary).toBe('Pricing changes drove Q3 churn; enterprise tier hit hardest.');
    expect(view.impact!.knowledgeGain).toBeCloseTo(0.45, 12);
  });

  it('enforces the tenant-scoped grounding FK at the SQL layer', async () => {
    const ctx = member(tenantStorage);
    const { plan } = await seedAnsweredAsk(ctx, { fullName: 'FK Fixture' });
    const contribution = await recordContribution(ctx, recordInput(plan.id));
    const validation = await validateContribution(ctx, validationInput(contribution.id));

    // a validation row claiming ANOTHER tenant's contribution is
    // unrepresentable (composite FK over tenant + contribution)
    await expect(
      getDb().query(
        `INSERT INTO contribution_validations (
           tenant_id, contribution_id, outcome, quality,
           actor_kind, actor_label, recorded_by_principal, recorded_at
         ) VALUES ($1, $2, 'validated', 0.5, 'system', 'forged', 'forged', now())`,
        [tenantB, contribution.id],
      ),
    ).rejects.toThrow();

    // an impact row grounding in another tenant's contribution likewise
    await expect(
      getDb().query(
        `INSERT INTO contribution_impacts (
           tenant_id, contribution_id, mission_impact,
           confidence_before, confidence_after, knowledge_gain,
           avoided_cost, actor_kind, actor_label, recorded_by_principal, recorded_at
         ) VALUES ($1, $2, 'advanced', 0.1, 0.2, 0.1, 0, 'system', 'forged', 'forged', now())`,
        [tenantB, contribution.id],
      ),
    ).rejects.toThrow();

    // nothing was forged: the series is still exactly one validation
    const series = await listValidations(ctx, { contributionId: contribution.id });
    expect(series.map((entry) => entry.id)).toEqual([validation.id]);
  });
});
