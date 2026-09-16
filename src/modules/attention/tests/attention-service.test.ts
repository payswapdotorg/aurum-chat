// Integration tests for the attention module against the embedded
// PostgreSQL (PGlite, `:memory:`) through the db port. Covers the W051
// acceptance — "material goal/evidence gaps create candidate unknowns
// without a user question; candidate unknowns contain impact, urgency,
// confidence gap and information value; only material unknowns become
// missions; discovery is evidence-linked and auditable; end-to-end
// synthetic proof exists":
//
//  * THE SYNTHETIC PROOF (ADR-0017's required verification): a synthetic
//    company fixture — an active churn-reduction goal with a metric, and
//    observations whose content does NOT reveal the hidden consequential
//    variable (a silent July price increase on one cohort) — where NO
//    operator question exists anywhere in the input: goal + evidence
//    evaluation alone produces the candidate unknown, the epistemic
//    unknown (W007) and the LearningMission (W011) with its acquisition
//    paths, all cross-linked and auditable.
//  * The policy gate: the built-in default materiality floor; explicit
//    policy set (claim-gated) and per-tenant isolation; 'auto' releases
//    missions inside discovery; 'manual' records the material candidate
//    and requires the explicit materialization call.
//  * ONLY MATERIALIZED CANDIDATES BECOME MISSIONS: an immaterial gap
//    records terminal 'immaterial' and creates NO unknown and NO mission;
//    materializing an immaterial candidate is refused; materialized is
//    terminal.
//  * THE AUDIT CHAIN: every candidate snapshots the policy thresholds
//    that decided it; the derived unknown carries question, consequence,
//    subject 'goals.goal' and the evidence links; the derived mission
//    carries affected goals, unknown refs, information value, urgency,
//    the confidence gap, policy budgets and the acquisition paths; the
//    recorded-by principal is system-captured.
//  * Input discipline: the confidence-gap rule, metric scoping against
//    the goal's current metrics, archived goals refused, duplicate gaps
//    conflict, evidence/execution/goal references validated through the
//    owning contracts with uniform cross-tenant semantics.
//  * APPEND-ONLY DISCOVERY: PostgreSQL triggers reject UPDATE (except the
//    one-way material -> materialized transition the service drives),
//    DELETE and TRUNCATE outright.
//  * Tenant isolation (ADR-0001) across every surface, with uniform
//    not-found semantics (no existence leaks).
//  * The listing: urgency-rank ordering and the status / goal / urgency /
//    proposer / execution / search filters.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { getUnknown, listUnknowns, recordClaim } from '@/modules/epistemics/contract';
import { createGoal, reviseGoal } from '@/modules/goals/contract';
import { getMission, listMissions } from '@/modules/missions/contract';
import { startExecution } from '@/modules/cognition/contract';
import { recordObservation } from '@/modules/observations/contract';
import { AttentionError } from '../errors';
import * as attentionContract from '../contract';
import type { DiscoverGoalGapInput } from '../types';
import { runMigrations } from '../../../../scripts/migrate';

const {
  discoverGoalGap,
  getCandidateUnknown,
  getDiscoveryPolicy,
  listCandidateUnknowns,
  materializeCandidate,
  setDiscoveryPolicy,
} = attentionContract;

// Dedicated tenants keep each concern's data isolated from the others.
const tenantProof = newId(); // the ADR-0017 synthetic fixture
const tenantManual = newId();
const tenantImmaterial = newId();
const tenantGate = newId();
const tenantIso = newId();
const tenantConflicts = newId();
const tenantAudit = newId();
const tenantList = newId();
const tenantExecution = newId();

const PERSON_ID = '0b2f8e2a-1c4b-4d8a-9f3e-7a2b6c5d4e8f';
const VP_CS_ID = '5a7d3e9f-6b1c-4d2a-8e4b-3f5c7d9e1a2b';

function member(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: [] };
}

function policyAdmin(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: ['attention:administer'] };
}

async function expectCode(code: string, fn: () => unknown): Promise<void> {
  try {
    await fn();
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(AttentionError);
    expect((error as AttentionError).code).toBe(code);
  }
}

// ---------------------------------------------------------------------------
// Synthetic-company seeding (all through the REAL sibling contracts)
// ---------------------------------------------------------------------------

/**
 * Seeds the synthetic company's churn-reduction goal: active direction
 * with a monthly-churn-rate metric the gap will hang off.
 */
async function seedChurnGoal(ctx: TenantContext): Promise<string> {
  const goal = await createGoal(ctx, {
    title: 'Q4 churn reduction',
    objective: 'Bring monthly churn back under control by fixing the dominant driver.',
    desiredState: 'Monthly churn at or below 2% with the driver addressed.',
    metrics: [{ name: 'monthly-churn-rate', unit: 'ratio', direction: 'at_most', threshold: 0.02 }],
    horizonEnd: '2027-06-30T00:00:00.000Z',
    owner: { kind: 'person', id: PERSON_ID, label: 'COO' },
    priority: 'high',
    successCriteria: 'Monthly churn <= 2% for two consecutive months.',
    actor: { kind: 'person', id: PERSON_ID },
    rationale: 'board-meeting-2026-09',
  });
  return goal.id;
}

/**
 * Seeds one tenant-visible observation. The payloads deliberately do NOT
 * contain the hidden consequential variable — only signals that make the
 * gap material.
 */
async function seedObservation(ctx: TenantContext, payload: unknown): Promise<string> {
  const observation = await recordObservation(ctx, {
    kind: 'metric.sample',
    payload,
    observedAt: '2026-09-10T08:00:00.000Z',
    source: { kind: 'system', label: 'bi-export' },
    channel: 'ingestion',
    confidence: { value: 0.9, method: 'system-pull' },
  });
  return observation.id;
}

/** Seeds one evidence claim derived from an observation (W007). */
async function seedClaim(ctx: TenantContext, proposition: string, observationId: string): Promise<string> {
  const claim = await recordClaim(ctx, {
    proposition,
    confidence: { value: 0.7, method: 'analyst' },
    evidenceObservationIds: [observationId],
  });
  return claim.id;
}

/** The unprompted evaluation input — NO operator question exists anywhere. */
function gapInput(overrides: Partial<DiscoverGoalGapInput> = {}): DiscoverGoalGapInput {
  return {
    goalId: '',
    metricName: 'monthly-churn-rate',
    missingKnowledge: 'Which customer cohort silently received the July price increase?',
    impactDescription:
      'Without knowing which cohort the July price increase hit, churn-mitigation decisions cannot be targeted and the Q4 churn goal cannot be met.',
    decisionImpact: 0.8,
    informationValue: 0.75,
    urgency: 'high',
    currentConfidence: 0.1,
    requiredConfidence: 0.85,
    evidenceObservationIds: [],
    acquisitionPaths: [
      { kind: 'person', id: VP_CS_ID, label: 'VP Customer Success' },
      { kind: 'system', label: 'billing-export' },
    ],
    proposer: { kind: 'system', label: 'goal-gap-evaluator' },
    proposerNote: 'Nightly goal evaluation pass; derived without any operator question.',
    ...overrides,
  };
}

async function expectRejected(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(
      /(forbidden on table|cannot be rewritten|illegal transition on table).*candidate_unknowns/i,
    );
  }
}

beforeAll(async () => {
  await runMigrations(getDb());
});

afterAll(async () => {
  await closeDb();
});

describe('contract surface (the module exposes exactly its public operations)', () => {
  it('pins the export set — no mutation or erase operation exists', async () => {
    // There is deliberately no updateCandidateUnknown, no dismissCandidate,
    // no eraseDiscovery and no setStatus shortcut: the materiality verdict
    // is minted by the deterministic gate, materialization is the one-way
    // service-driven transition, and erasure is impossible by trigger.
    expect(Object.keys(attentionContract).sort()).toEqual([
      'ACQUISITION_PATH_KINDS',
      'ATTENTION_AUTHORITY_ADMINISTER',
      'AttentionError',
      'BUILT_IN_DISCOVERY_POLICY',
      'CANDIDATE_UNKNOWN_STATUSES',
      'DEFAULT_INVESTIGATION_BUDGET',
      'DEFAULT_LIST_LIMIT',
      'DEFAULT_MIN_DECISION_IMPACT',
      'DEFAULT_MIN_INFORMATION_VALUE',
      'DEFAULT_MISSION_POLICY',
      'DEFAULT_REWARD_BUDGET',
      'GAP_PROPOSER_KINDS',
      'GAP_URGENCIES',
      'GOAL_GAP_SUBJECT_KIND',
      'MAX_ACQUISITION_PATHS',
      'MAX_BUDGET_AMOUNT',
      'MAX_EVIDENCE_CLAIMS',
      'MAX_EVIDENCE_OBSERVATIONS',
      'MAX_IMPACT_DESCRIPTION_CHARS',
      'MAX_LIST_LIMIT',
      'MAX_METRIC_NAME_CHARS',
      'MAX_MISSING_KNOWLEDGE_CHARS',
      'MAX_PROPOSER_LABEL_CHARS',
      'MAX_PROPOSER_NOTE_CHARS',
      'MAX_SEARCH_CHARS',
      'MISSION_POLICY_MODES',
      'canAdministerDiscoveryPolicy',
      'deriveMissionDefinition',
      'deriveUnknownRecord',
      'discoverGoalGap',
      'escapeLike',
      'evaluateMateriality',
      'getCandidateUnknown',
      'getDiscoveryPolicy',
      'isAcquisitionPathKind',
      'isCandidateUnknownStatus',
      'isGapProposerKind',
      'isGapUrgency',
      'isMissionPolicyMode',
      'isUuid',
      'listCandidateUnknowns',
      'materializeCandidate',
      'setDiscoveryPolicy',
      'urgencyRank',
    ]);
  });
});

describe('discovery policy (the materiality gate configuration)', () => {
  it('returns the built-in floor before any tenant row exists', async () => {
    const ctx = member(tenantGate);
    const policy = await getDiscoveryPolicy(ctx);
    expect(policy.source).toBe('built-in');
    expect(policy.minDecisionImpact).toBe(0.5);
    expect(policy.minInformationValue).toBe(0.5);
    expect(policy.missionPolicy).toBe('auto');
    expect(policy.investigationBudget).toEqual({ amount: 0, currency: 'EUR' });
    expect(policy.rewardBudget).toEqual({ amount: 0, currency: 'EUR' });
    expect(policy.updatedAt).toBeNull();
    expect(policy.updatedBy).toBeNull();
  });

  it('requires the attention:administer claim to set the policy', async () => {
    const ctx = member(tenantGate);
    await expectCode('forbidden', () =>
      setDiscoveryPolicy(ctx, {
        minDecisionImpact: 0.6,
        minInformationValue: 0.5,
        missionPolicy: 'manual',
        investigationBudget: { amount: 100_00, currency: 'EUR' },
        rewardBudget: { amount: 20_00, currency: 'EUR' },
      }),
    );
  });

  it('sets, returns and replaces the tenant row with audit fields', async () => {
    const admin = policyAdmin(tenantGate);
    const before = new Date();
    const first = await setDiscoveryPolicy(admin, {
      minDecisionImpact: 0.6,
      minInformationValue: 0.55,
      missionPolicy: 'manual',
      investigationBudget: { amount: 100_00, currency: 'EUR' },
      rewardBudget: { amount: 20_00, currency: 'EUR' },
    });
    const after = new Date();
    expect(first.updatedBy).toBe(admin.principalId);
    expect(Date.parse(first.updatedAt!)).toBeGreaterThanOrEqual(before.getTime());
    expect(Date.parse(first.updatedAt!)).toBeLessThanOrEqual(after.getTime());

    const second = await setDiscoveryPolicy(admin, {
      minDecisionImpact: 0.7,
      minInformationValue: 0.6,
      missionPolicy: 'auto',
      investigationBudget: { amount: 250_00, currency: 'EUR' },
      rewardBudget: { amount: 50_00, currency: 'EUR' },
    });
    expect(second.minDecisionImpact).toBe(0.7);
    expect(second.missionPolicy).toBe('auto');
    expect(second.investigationBudget).toEqual({ amount: 250_00, currency: 'EUR' });
    expect(second.updatedBy).toBe(admin.principalId);

    const effective = await getDiscoveryPolicy(admin);
    expect(effective.source).toBe('tenant');
    expect(effective.minDecisionImpact).toBe(0.7);
  });

  it('isolates policies per tenant (another tenant still sees the built-in floor)', async () => {
    await setDiscoveryPolicy(policyAdmin(tenantGate), {
      minDecisionImpact: 0.9,
      minInformationValue: 0.9,
      missionPolicy: 'manual',
      investigationBudget: { amount: 0, currency: 'EUR' },
      rewardBudget: { amount: 0, currency: 'EUR' },
    });
    const other = await getDiscoveryPolicy(member(tenantIso));
    expect(other.source).toBe('built-in');
    expect(other.minDecisionImpact).toBe(0.5);
  });
});

describe('THE SYNTHETIC PROOF (ADR-0017 required verification)', () => {
  // The hidden consequential variable: a silent July price increase was
  // applied to one cohort. It appears in NO observation and NO claim —
  // only its SYMPTOMS do. No operator question exists anywhere: the input
  // is goal + evidence evaluation only.
  it('goal + evidence evaluation alone produces the candidate, the unknown and the mission', async () => {
    const ctx = member(tenantProof);

    // The synthetic company's direction.
    const goalId = await seedChurnGoal(ctx);

    // Evidence: churn elevated (the symptom), nothing about the cause.
    const churnObs = await seedObservation(ctx, {
      metric: 'monthly-churn-rate',
      period: '2026-09',
      value: 0.031,
      baseline: 0.019,
    });
    const complaintObs = await seedObservation(ctx, {
      kind: 'support-volume',
      detail: 'Cancellation complaints up 40% week-over-week; billing cited in 12% of tickets.',
    });
    const claim = await seedClaim(
      ctx,
      'Churn rose from 1.9% to 3.1% between August and September 2026.',
      churnObs,
    );

    const before = new Date();
    const candidate = await discoverGoalGap(
      ctx,
      gapInput({
        goalId,
        evidenceObservationIds: [churnObs, complaintObs],
        evidenceClaimIds: [claim],
      }),
    );
    const after = new Date();

    // The candidate: material, auto-materialized under the built-in
    // 'auto' policy, fully auditable.
    expect(candidate.tenantId).toBe(tenantProof);
    expect(candidate.status).toBe('materialized');
    expect(candidate.materiality.decision).toBe('material');
    expect(candidate.materiality.minDecisionImpact).toBe(0.5);
    expect(candidate.materiality.minInformationValue).toBe(0.5);
    expect(candidate.materiality.basis).toBe(
      'decision impact 0.8 >= 0.5 and information value 0.75 >= 0.5',
    );
    expect(candidate.decisionImpact).toBe(0.8);
    expect(candidate.informationValue).toBe(0.75);
    expect(candidate.urgency).toBe('high');
    expect(candidate.currentConfidence).toBe(0.1);
    expect(candidate.requiredConfidence).toBe(0.85);
    expect(candidate.confidenceGap).toBeCloseTo(0.75, 10);
    // Evidence links are stored sorted + deduplicated (the epistemics discipline).
    expect(candidate.evidenceObservationIds).toEqual(
      [churnObs, complaintObs].slice().sort(),
    );
    expect(candidate.evidenceClaimIds).toEqual([claim]);
    expect(candidate.proposer).toEqual({ kind: 'system', id: null, label: 'goal-gap-evaluator' });
    expect(candidate.recordedByPrincipal).toBe(ctx.principalId);
    for (const stamp of [candidate.recordedAt, candidate.materialization!.materializedAt]) {
      expect(Date.parse(stamp)).toBeGreaterThanOrEqual(before.getTime());
      expect(Date.parse(stamp)).toBeLessThanOrEqual(after.getTime());
    }
    expect(candidate.materialization!.materializedBy).toBe(ctx.principalId);

    // The epistemic unknown (W007): question, consequence, subject,
    // evidence links — all derived deterministically from the candidate.
    const unknown = await getUnknown(ctx, { unknownId: candidate.materialization!.unknownId });
    expect(unknown.question).toBe(
      'Which customer cohort silently received the July price increase?',
    );
    expect(unknown.consequence).toBe(
      'Without knowing which cohort the July price increase hit, churn-mitigation decisions cannot be targeted and the Q4 churn goal cannot be met.',
    );
    expect(unknown.subject).toEqual({ kind: 'goals.goal', id: goalId });
    expect(unknown.status).toBe('open');
    expect(unknown.relatedObservationIds).toEqual([churnObs, complaintObs].slice().sort());
    expect(unknown.relatedClaimIds).toEqual([claim]);
    expect(unknown.note).toContain(candidate.id);

    // The LearningMission (W011): the full ADR-0017 field set, launched
    // through the policy gate's budgets, offering the planner the
    // acquisition paths.
    const mission = await getMission(ctx, candidate.materialization!.missionId);
    expect(mission.content.status).toBe('active');
    expect(mission.version).toBe(1);
    expect(mission.lastChange.kind).toBe('created');
    expect(mission.content.title).toBe('Goal gap · Q4 churn reduction · monthly-churn-rate');
    expect(mission.content.knowledgeObjective).toBe(
      'Which customer cohort silently received the July price increase?',
    );
    expect(mission.content.affectedGoals).toEqual([
      { goalId, label: 'Q4 churn reduction' },
    ]);
    expect(mission.content.unknownIds).toEqual([unknown.id]);
    expect(mission.content.informationValue).toBe(0.75);
    expect(mission.content.urgency).toBe('high');
    expect(mission.content.currentConfidence).toBe(0.1);
    expect(mission.content.targetConfidence).toBe(0.85);
    expect(mission.content.investigationBudget).toEqual({ amount: 0, currency: 'EUR' });
    expect(mission.content.rewardBudget).toEqual({ amount: 0, currency: 'EUR' });
    expect(mission.content.candidateSources).toEqual([
      { kind: 'person', id: VP_CS_ID, label: 'VP Customer Success' },
      { kind: 'system', id: null, label: 'billing-export' },
    ]);
    expect(mission.content.completionCriteria).toContain('0.85');
    expect(mission.lastChange.actor).toEqual({
      kind: 'system',
      id: null,
      label: 'goal-gap-evaluator',
    });
    expect(mission.lastChange.rationale).toContain(candidate.id);
    expect(mission.lastChange.rationale).toContain('materiality');

    // Reconstructability (§24): the candidate deep-links everything.
    const reread = await getCandidateUnknown(ctx, { candidateId: candidate.id });
    expect(reread).toEqual(candidate);
  });

  it('records NO unknown and NO mission for an immaterial gap (the policy gate holds)', async () => {
    const ctx = member(tenantImmaterial);
    const goalId = await seedChurnGoal(ctx);
    const obs = await seedObservation(ctx, { metric: 'monthly-churn-rate', value: 0.021 });

    const unknownsBefore = (await listUnknowns(ctx, { limit: 500 })).length;
    const missionsBefore = (await listMissions(ctx, { limit: 500 })).length;

    const candidate = await discoverGoalGap(
      ctx,
      gapInput({
        goalId,
        // Well below the built-in floor on BOTH dimensions.
        decisionImpact: 0.2,
        informationValue: 0.3,
        missingKnowledge: 'Which desk plant sits nearest the north window?',
        impactDescription: ' purely decorative curiosity.',
        evidenceObservationIds: [obs],
      }),
    );
    expect(candidate.status).toBe('immaterial');
    expect(candidate.materiality.decision).toBe('immaterial');
    expect(candidate.materialization).toBeNull();

    expect((await listUnknowns(ctx, { limit: 500 })).length).toBe(unknownsBefore);
    expect((await listMissions(ctx, { limit: 500 })).length).toBe(missionsBefore);

    // And it can never be materialized later.
    await expectCode('candidate_not_material', () =>
      materializeCandidate(ctx, { candidateId: candidate.id }),
    );
  });
});

describe('materialization policy (mission creation is policy-gated)', () => {
  it('manual policy records material candidates without launching missions', async () => {
    const ctx = member(tenantManual);
    const goalId = await seedChurnGoal(ctx);
    const obs = await seedObservation(ctx, { metric: 'monthly-churn-rate', value: 0.031 });

    await setDiscoveryPolicy(policyAdmin(tenantManual), {
      minDecisionImpact: 0.5,
      minInformationValue: 0.5,
      missionPolicy: 'manual',
      investigationBudget: { amount: 120_00, currency: 'EUR' },
      rewardBudget: { amount: 30_00, currency: 'EUR' },
    });

    const candidate = await discoverGoalGap(
      ctx,
      gapInput({ goalId, evidenceObservationIds: [obs] }),
    );
    expect(candidate.status).toBe('material');
    expect(candidate.materialization).toBeNull();
    expect((await listMissions(ctx, { limit: 500 })).length).toBe(0);

    // The explicit release: application-owned, auditable.
    const materialized = await materializeCandidate(ctx, { candidateId: candidate.id });
    expect(materialized.status).toBe('materialized');
    expect(materialized.materialization!.unknownId).toBeTruthy();
    expect(materialized.materialization!.missionId).toBeTruthy();
    expect(materialized.materialization!.materializedBy).toBe(ctx.principalId);

    const mission = await getMission(ctx, materialized.materialization!.missionId);
    expect(mission.content.investigationBudget).toEqual({ amount: 120_00, currency: 'EUR' });
    expect(mission.content.rewardBudget).toEqual({ amount: 30_00, currency: 'EUR' });

    // Terminal: a second materialization is refused.
    await expectCode('candidate_already_materialized', () =>
      materializeCandidate(ctx, { candidateId: candidate.id }),
    );
  });

  it('refuses materialization when the goal is no longer active', async () => {
    const ctx = member(tenantManual);
    const goalId = await seedChurnGoal(ctx);
    const obs = await seedObservation(ctx, { metric: 'monthly-churn-rate', value: 0.03 });

    await setDiscoveryPolicy(policyAdmin(tenantManual), {
      minDecisionImpact: 0.5,
      minInformationValue: 0.5,
      missionPolicy: 'manual',
      investigationBudget: { amount: 0, currency: 'EUR' },
      rewardBudget: { amount: 0, currency: 'EUR' },
    });
    const candidate = await discoverGoalGap(
      ctx,
      gapInput({ goalId, evidenceObservationIds: [obs] }),
    );
    expect(candidate.status).toBe('material');

    await reviseGoal(ctx, {
      goalId,
      status: 'archived',
      actor: { kind: 'person', id: PERSON_ID },
      rationale: 'direction changed',
    });
    await expectCode('goal_not_active', () =>
      materializeCandidate(ctx, { candidateId: candidate.id }),
    );
  });
});

describe('discovery input discipline (the application decides, never the proposer)', () => {
  it('rejects a goal that is missing or belongs to another tenant (uniform invalid_reference)', async () => {
    const ctx = member(tenantConflicts);
    const obs = await seedObservation(ctx, { metric: 'x', value: 1 });
    await expectCode('invalid_reference', () =>
      discoverGoalGap(ctx, gapInput({ goalId: newId(), evidenceObservationIds: [obs] })),
    );

    const other = member(tenantIso);
    const otherGoal = await seedChurnGoal(other);
    const otherObs = await seedObservation(other, { metric: 'x', value: 1 });
    // A foreign goal is indistinguishable from a missing one.
    await expectCode('invalid_reference', () =>
      discoverGoalGap(ctx, gapInput({ goalId: otherGoal, evidenceObservationIds: [obs] })),
    );
    // The same evaluation succeeds in the goal's own tenant.
    const inTenant = await discoverGoalGap(
      other,
      gapInput({ goalId: otherGoal, evidenceObservationIds: [otherObs] }),
    );
    expect(inTenant.status).toBe('materialized');
  });

  it('refuses archived goals — discovery derives from ACTIVE direction', async () => {
    const ctx = member(tenantConflicts);
    const goalId = await seedChurnGoal(ctx);
    const obs = await seedObservation(ctx, { metric: 'x', value: 1 });
    await reviseGoal(ctx, {
      goalId,
      status: 'archived',
      actor: { kind: 'person', id: PERSON_ID },
      rationale: 'done',
    });
    await expectCode('goal_not_active', () =>
      discoverGoalGap(ctx, gapInput({ goalId, evidenceObservationIds: [obs] })),
    );
  });

  it('validates metric scoping against the goal current metrics', async () => {
    const ctx = member(tenantConflicts);
    const goalId = await seedChurnGoal(ctx);
    const obs = await seedObservation(ctx, { metric: 'x', value: 1 });
    await expectCode('invalid_discovery_input', () =>
      discoverGoalGap(
        ctx,
        gapInput({ goalId, metricName: 'nps-score', evidenceObservationIds: [obs] }),
      ),
    );
    // The goal's own metric passes.
    const candidate = await discoverGoalGap(
      ctx,
      gapInput({ goalId, evidenceObservationIds: [obs] }),
    );
    expect(candidate.metricName).toBe('monthly-churn-rate');
  });

  it('enforces the confidence-gap rule at the service boundary', async () => {
    const ctx = member(tenantConflicts);
    const goalId = await seedChurnGoal(ctx);
    const obs = await seedObservation(ctx, { metric: 'x', value: 1 });
    await expectCode('invalid_discovery_input', () =>
      discoverGoalGap(
        ctx,
        gapInput({ goalId, currentConfidence: 0.9, requiredConfidence: 0.85, evidenceObservationIds: [obs] }),
      ),
    );
  });

  it('requires readable evidence: missing and foreign-tenant observations are uniform invalid_evidence', async () => {
    const ctx = member(tenantConflicts);
    const goalId = await seedChurnGoal(ctx);
    const obs = await seedObservation(ctx, { metric: 'x', value: 1 });
    await expectCode('invalid_evidence', () =>
      discoverGoalGap(ctx, gapInput({ goalId, evidenceObservationIds: [newId()] })),
    );

    const other = member(tenantIso);
    const otherObs = await seedObservation(other, { metric: 'x', value: 1 });
    await expectCode('invalid_evidence', () =>
      discoverGoalGap(ctx, gapInput({ goalId, evidenceObservationIds: [otherObs] })),
    );

    const otherClaim = await seedClaim(other, 'foreign claim', otherObs);
    await expectCode('invalid_evidence', () =>
      discoverGoalGap(
        ctx,
        gapInput({ goalId, evidenceObservationIds: [obs], evidenceClaimIds: [otherClaim] }),
      ),
    );
  });

  it('validates the cognitive-execution link through the cognition contract', async () => {
    const ctx = member(tenantExecution);
    const goalId = await seedChurnGoal(ctx);
    const obs = await seedObservation(ctx, { metric: 'x', value: 1 });

    await expectCode('invalid_reference', () =>
      discoverGoalGap(ctx, gapInput({ goalId, evidenceObservationIds: [obs], executionId: newId() })),
    );

    const other = member(tenantIso);
    const otherExecution = await startExecution(other, {
      trigger: { kind: 'system', label: 'nightly-cycle' },
      focus: { topics: ['churn'], entities: [] },
      actor: { kind: 'system', label: 'worker' },
    });
    await expectCode('invalid_reference', () =>
      discoverGoalGap(
        ctx,
        gapInput({ goalId, evidenceObservationIds: [obs], executionId: otherExecution.id }),
      ),
    );

    // An in-tenant execution links and is listable (trace reconstruction).
    const execution = await startExecution(ctx, {
      trigger: { kind: 'system', label: 'nightly-cycle' },
      focus: { topics: ['churn'], entities: [] },
      actor: { kind: 'system', label: 'worker' },
    });
    const candidate = await discoverGoalGap(
      ctx,
      gapInput({ goalId, evidenceObservationIds: [obs], executionId: execution.id }),
    );
    expect(candidate.executionId).toBe(execution.id);
    const byExecution = await listCandidateUnknowns(ctx, { executionId: execution.id });
    expect(byExecution.map((item) => item.id)).toEqual([candidate.id]);
  });

  it('conflicts on re-registration of the same gap (look at what is recorded)', async () => {
    const ctx = member(tenantConflicts);
    const goalId = await seedChurnGoal(ctx);
    const obs = await seedObservation(ctx, { metric: 'x', value: 1 });
    const input = gapInput({ goalId, evidenceObservationIds: [obs] });
    const first = await discoverGoalGap(ctx, input);
    await expectCode('candidate_conflict', () => discoverGoalGap(ctx, input));

    // A different gap statement on the same goal is a new candidate...
    const second = await discoverGoalGap(
      ctx,
      gapInput({
        goalId,
        missingKnowledge: 'Did the August pricing memo reach all account managers?',
        evidenceObservationIds: [obs],
      }),
    );
    expect(second.id).not.toBe(first.id);
    // ...and a different metric is a different gap too.
    const third = await discoverGoalGap(
      ctx,
      gapInput({ goalId, metricName: null, evidenceObservationIds: [obs] }),
    );
    expect(third.id).not.toBe(first.id);
  });
});

describe('append-only discovery storage (triggers reject every illegal mutation)', () => {
  it('rejects DELETE, TRUNCATE, terminal rewrites and illegal transitions', async () => {
    const ctx = member(tenantAudit);
    const goalId = await seedChurnGoal(ctx);
    const obs = await seedObservation(ctx, { metric: 'x', value: 1 });

    // An immaterial row is terminal on arrival.
    const immaterial = await discoverGoalGap(
      ctx,
      gapInput({
        goalId,
        decisionImpact: 0.1,
        informationValue: 0.1,
        evidenceObservationIds: [obs],
      }),
    );
    await expectRejected(() =>
      getDb().query(`DELETE FROM candidate_unknowns WHERE id = $1`, [immaterial.id]),
    );
    await expectRejected(() =>
      getDb().query(
        `UPDATE candidate_unknowns SET missing_knowledge = 'rewritten' WHERE id = $1`,
        [immaterial.id],
      ),
    );

    // A materialized row is terminal.
    const materialized = await discoverGoalGap(
      ctx,
      gapInput({
        goalId,
        missingKnowledge: 'Materialized gap for the audit suite?',
        evidenceObservationIds: [obs],
      }),
    );
    expect(materialized.status).toBe('materialized');
    await expectRejected(() =>
      getDb().query(`DELETE FROM candidate_unknowns WHERE id = $1`, [materialized.id]),
    );
    await expectRejected(() =>
      getDb().query(`UPDATE candidate_unknowns SET decision_impact = 0.99 WHERE id = $1`, [
        materialized.id,
      ]),
    );

    await expectRejected(() => getDb().query(`TRUNCATE TABLE candidate_unknowns`));
  });
});

describe('tenant isolation (ADR-0001)', () => {
  it('hides another tenant\u2019s candidates behind uniform not-found', async () => {
    const ctxA = member(tenantIso);
    const goalId = await seedChurnGoal(ctxA);
    const obs = await seedObservation(ctxA, { metric: 'x', value: 1 });
    const candidate = await discoverGoalGap(
      ctxA,
      gapInput({ goalId, evidenceObservationIds: [obs] }),
    );

    const ctxB = member(tenantProof);
    await expectCode('candidate_not_found', () =>
      getCandidateUnknown(ctxB, { candidateId: candidate.id }),
    );
    await expectCode('candidate_not_found', () =>
      materializeCandidate(ctxB, { candidateId: candidate.id }),
    );
    const foreign = await listCandidateUnknowns(ctxB, { goalId });
    expect(foreign).toEqual([]);
  });
});

describe('the discovery feed (listCandidateUnknowns)', () => {
  it('filters by status, goal, urgency, proposer and search; orders urgency-first', async () => {
    const ctx = member(tenantList);
    const goalId = await seedChurnGoal(ctx);
    const obs = await seedObservation(ctx, { metric: 'x', value: 1 });

    await setDiscoveryPolicy(policyAdmin(tenantList), {
      minDecisionImpact: 0.5,
      minInformationValue: 0.5,
      missionPolicy: 'manual',
      investigationBudget: { amount: 0, currency: 'EUR' },
      rewardBudget: { amount: 0, currency: 'EUR' },
    });

    const critical = await discoverGoalGap(
      ctx,
      gapInput({
        goalId,
        urgency: 'critical',
        missingKnowledge: 'Critical gap: which supplier drove the Q3 delivery spike?',
        evidenceObservationIds: [obs],
        proposer: { kind: 'person', id: PERSON_ID },
      }),
    );
    const low = await discoverGoalGap(
      ctx,
      gapInput({
        goalId,
        urgency: 'low',
        decisionImpact: 0.3,
        missingKnowledge: 'Low-value gap: which logo decorates the lobby wall?',
        evidenceObservationIds: [obs],
        proposer: { kind: 'agent', label: 'night-evaluator' },
      }),
    );
    expect(low.status).toBe('immaterial');

    // Urgency-rank ordering across the whole feed.
    const all = await listCandidateUnknowns(ctx, {});
    expect(all.map((item) => item.id)).toEqual([critical.id, low.id]);

    // Filters.
    expect((await listCandidateUnknowns(ctx, { status: 'material' })).map((i) => i.id)).toEqual([
      critical.id,
    ]);
    expect((await listCandidateUnknowns(ctx, { status: 'immaterial' })).map((i) => i.id)).toEqual([
      low.id,
    ]);
    expect((await listCandidateUnknowns(ctx, { goalId })).length).toBe(2);
    expect((await listCandidateUnknowns(ctx, { goalId: newId() })).length).toBe(0);
    expect((await listCandidateUnknowns(ctx, { urgency: 'critical' })).map((i) => i.id)).toEqual([
      critical.id,
    ]);
    expect(
      (await listCandidateUnknowns(ctx, { proposerKind: 'person', proposerId: PERSON_ID })).map(
        (i) => i.id,
      ),
    ).toEqual([critical.id]);
    expect(
      (await listCandidateUnknowns(ctx, { proposerKind: 'agent' })).map((i) => i.id),
    ).toEqual([low.id]);
    expect(
      (await listCandidateUnknowns(ctx, { search: 'delivery spike' })).map((i) => i.id),
    ).toEqual([critical.id]);
    expect((await listCandidateUnknowns(ctx, { search: 'nothing matches this' })).length).toBe(0);
    // Wildcards in search text are literal, never patterns.
    expect((await listCandidateUnknowns(ctx, { search: '%' })).length).toBe(0);

    // get/list validation surfaces.
    await expectCode('invalid_query', () => listCandidateUnknowns(ctx, { limit: 0 }));
    await expectCode('invalid_query', () => getCandidateUnknown(ctx, { candidateId: 'nope' }));
    await expectCode('invalid_context', () =>
      getCandidateUnknown(
        { tenantId: '', principalId: 'p', authority: [] },
        { candidateId: critical.id },
      ),
    );
  });
});
