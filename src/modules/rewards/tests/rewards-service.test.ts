// Integration tests for the rewards module against the embedded PostgreSQL
// (PGlite, `:memory:`) through the db port. Covers the W043 acceptance:
//
//  * EXPLICIT POLICIES: no policy ⇒ `policy_not_configured`; policy
//    writes are claim-gated ('rewards:administer'); the policy is
//    versioned and updatable; later policy edits never rewrite what a
//    recorded reward snapshot decided.
//  * APPLY EXPLICIT POLICIES TO VALUABLE CONTRIBUTIONS: the full
//    acquisition-plan flow (seeded askable employee → mission with reward
//    budget/terms → planned ask → answered outcome) derives the
//    contributor and mission, snapshots the value assessment, the policy
//    and the mission reward budget, computes the deterministic tier and
//    records ONE append-only reward; the knowledge-contribution reference
//    flow (the merge-time surface for W042) works identically with
//    caller-supplied anchor data.
//  * NO REWARD DUE: non-qualifying status / below-tier values return the
//    deterministic assessment and record NOTHING.
//  * SEPARATE FROM COMPENSATION/PERFORMANCE: the storage CHECK rejects a
//    compensation-shaped reward kind on a raw insert; the reward carries
//    no compensation or performance field anywhere.
//  * §20 AUTHORITY GATE (the W009 dependency, load-bearing): default
//    matrix approval-gates EXECUTE ⇒ 'proposed'; a human decision via the
//    actions contract (separation of duties enforced) settles it
//    ('granted'/'declined'); a relaxed tenant row auto-grants ('granted'
//    minted directly, policy decision recorded); a forbidding row refuses
//    ('refused' retained as evidence); settle-before-decision ⇒
//    `reward_still_proposed`; settle of a non-proposed reward ⇒
//    `reward_not_proposed`; first settlement wins.
//  * MISSION REWARD BUDGET: granted+proposed commit budget, declined
//    frees it, budget exhaustion ⇒ `budget_exceeded`; currency
//    mismatches (mission budget vs policy; cost avoided vs policy) ⇒
//    `currency_mismatch`; abandoned missions are not rewardable.
//  * ONE REWARD PER CONTRIBUTION: re-application ⇒ `reward_conflict`.
//  * ANCHOR VALIDATION: unanswered/no-candidate/label-only plans and
//    foreign-tenant plan ids are uniformly `invalid_contribution_ref`.
//  * APPEND-ONLY: UPDATE/DELETE/TRUNCATE rejected by triggers on both
//    tables (the policy row is deliberately updatable).
//  * TENANT ISOLATION (ADR-0001) with uniform not-found semantics.
//  * READS: getReward round-trips every snapshot; listRewards filters
//    (mission, contributor, kind, derived status); summarizeRewards
//    rolls up statuses, kinds, committed currency totals and distinct
//    contributors.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import {
  ACTIONS_AUTHORITY_ADMINISTER,
  ACTIONS_AUTHORITY_APPROVE,
  decideApproval,
  getActionRequest,
  setAuthorityPolicy,
} from '@/modules/actions/contract';
import {
  IDENTITY_AUTHORITY_ATTEST,
  IDENTITY_AUTHORITY_LINK,
  attestIdentity,
  registerExternalIdentity,
} from '@/modules/identity/contract';
import {
  createEmployee,
  createPerson,
  linkExternalIdentity,
  type Person,
} from '@/modules/people/contract';
import {
  abandonMission,
  completeMission,
  createMission,
  type CreateMissionInput,
  type Mission,
} from '@/modules/missions/contract';
import {
  planNextAcquisition,
  recordAcquisitionOutcome,
} from '@/modules/knowledge-acquisition/contract';
import { RewardsError } from '../errors';
import * as rewardsContract from '../contract';
import type { Reward, RewardPolicy, SetRewardPolicyInput } from '../types';
import { runMigrations } from '../../../../scripts/migrate';

const {
  applyRewardPolicy,
  getReward,
  getRewardPolicy,
  listRewards,
  setRewardPolicy,
  settleReward,
  summarizeRewards,
} = rewardsContract;

// Dedicated tenants keep each concern's data isolated from the others.
const tenantMain = newId();
const tenantAuto = newId();
const tenantForbidden = newId();
const tenantNoDue = newId();
const tenantBudget = newId();
const tenantSettle = newId();
const tenantAnchor = newId();
const tenantIso = newId();
const tenantReads = newId();
const tenantComp = newId();

function member(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: [] };
}

function rewardAdmin(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: [rewardsContract.REWARDS_AUTHORITY_ADMINISTER] };
}

function actionsAdmin(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: [ACTIONS_AUTHORITY_ADMINISTER] };
}

function approver(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: [ACTIONS_AUTHORITY_APPROVE] };
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
    expect(error).toBeInstanceOf(RewardsError);
    expect((error as RewardsError).code).toBe(code);
  }
}

// ---------------------------------------------------------------------------
// Seeds
// ---------------------------------------------------------------------------

let identityCounter = 0;

/** A person with an active employment and a verified linked identity. */
async function askableEmployee(tenantId: string, fullName: string): Promise<Person> {
  const person = await createPerson(member(tenantId), { fullName });
  await createEmployee(member(tenantId), { personId: person.id, title: `Title of ${fullName}` });
  identityCounter += 1;
  const registered = await registerExternalIdentity(member(tenantId), {
    provider: 'slack',
    providerAccountId: `slack-${tenantId.slice(0, 8)}-${identityCounter}`,
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
    rewardBudget: { amount: 100_00, currency: 'EUR' },
    rewardTerms: 'A thank-you gift for qualifying contributions.',
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

/** An answered ask-person acquisition plan (the contribution anchor). */
async function answeredAskPlan(
  ctx: TenantContext,
  personId: string,
  personLabel: string,
  missionId: string,
): Promise<{ planId: string; missionId: string; personId: string }> {
  const mission = { id: missionId };
  const plan = await planNextAcquisition(ctx, {
    missionId: mission.id,
    candidates: [
      {
        kind: 'person',
        id: personId,
        label: personLabel,
        relevance: 0.9,
        reliability: 0.9,
        freshness: 0.9,
        authority: 0.9,
        expectedQuality: 0.9,
        priorContributionValue: 0.5,
        cost: 0,
        access: 'allowed',
      },
    ],
    actor: { kind: 'system', label: 'aurum-cognition' },
  });
  expect(plan.action).toBe('ask-person');
  const answered = await recordAcquisitionOutcome(ctx, {
    planId: plan.id,
    outcome: 'answered',
    evidence: {
      payload: { answer: 'Pricing drove churn.' },
      confidence: { value: 0.8, method: 'source_trust' },
    },
  });
  expect(answered.outcome?.outcome).toBe('answered');
  return { planId: plan.id, missionId: mission.id, personId };
}

function policyInput(overrides: Partial<SetRewardPolicyInput> = {}): SetRewardPolicyInput {
  return {
    tiers: [
      { name: 'thank-you', minValueScore: 0.25, kind: 'recognition', amount: 0 },
      { name: 'thank-you-gift', minValueScore: 0.5, kind: 'gift', amount: 50_00 },
      { name: 'valued-contributor', minValueScore: 0.75, kind: 'voucher', amount: 150_00 },
    ],
    rewardCurrency: 'EUR',
    ...overrides,
  };
}

/** The §8 value assessment of a valuable (validated + measured) contribution. */
function valuableValue(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: 'measured',
    knowledgeGain: 0.4,
    missionImpact: 'resolved',
    affectedGoals: [{ goalId: newId(), label: 'Churn goal' }],
    costAvoided: { amount: 250_00, currency: 'EUR' },
    ...overrides,
  };
}

/** An application anchored to a knowledge-contribution reference. */
function knowledgeContributionApplication(
  missionId: string,
  personId: string,
  valueOverrides: Record<string, unknown> = {},
): rewardsContract.ApplyRewardPolicyInput {
  return {
    contribution: {
      kind: 'knowledge-contribution',
      id: newId(),
      contributor: { personId, label: 'Ada Lovelace' },
    },
    missionId,
    value: valuableValue(valueOverrides) as unknown as rewardsContract.ContributionValue,
    actor: { kind: 'system', label: 'aurum-cognition' },
    rationale: 'mission resolved by this contribution',
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
  it('pins the export set — no mutation or erase operation exists', () => {
    // There is deliberately no updateReward, no unSettle, no deleteReward,
    // no grantReward outside the policy: configured rewards are
    // append-only history.
    expect(Object.keys(rewardsContract).sort()).toEqual(
      [
        'COMPENSATION_EXCLUDED_KINDS',
        'CONTRIBUTION_REF_KINDS',
        'CONTRIBUTION_STATUSES',
        'DEFAULT_LIST_LIMIT',
        'MAX_AFFECTED_GOALS',
        'MAX_AMOUNT',
        'MAX_LABEL_LENGTH',
        'MAX_LIST_LIMIT',
        'MAX_NOTE_LENGTH',
        'MAX_RATIONALE_LENGTH',
        'MAX_TIER_NAME_LENGTH',
        'MAX_TIERS',
        'MISSION_IMPACT_KINDS',
        'REWARD_ACTION_KIND',
        'REWARD_AUTHORITY_LEVEL',
        'REWARD_KINDS',
        'REWARD_PARTY_KINDS',
        'REWARD_STATUSES',
        'REWARDS_AUTHORITY_ADMINISTER',
        'RewardsError',
        'SETTLEMENT_DECISIONS',
        'applyRewardPolicy',
        'canAdministerRewards',
        'derivedRewardStatus',
        'evaluateRewardPolicy',
        'getReward',
        'getRewardPolicy',
        'isContributionRefKind',
        'isContributionStatus',
        'isMissionImpactKind',
        'isRewardKind',
        'isRewardPartyKind',
        'isRewardStatus',
        'isSettlementDecision',
        'isUuid',
        'listRewards',
        'mintedStatusForOutcome',
        'mintedStatusForRequestStatus',
        'setRewardPolicy',
        'settleReward',
        'snapshotPolicy',
        'summarizeRewards',
      ].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// Explicit policy management
// ---------------------------------------------------------------------------

describe('reward policy management', () => {
  it('starts unconfigured and refuses to apply without an explicit policy', async () => {
    const ctx = member(tenantMain);
    await expect(getRewardPolicy(ctx)).resolves.toBeNull();
    await expectCode('policy_not_configured', () =>
      applyRewardPolicy(ctx, knowledgeContributionApplication(newId(), newId())),
    );
  });

  it('is claim-gated: a plain member cannot write the policy', async () => {
    await expectCode('forbidden', () => setRewardPolicy(member(tenantMain), policyInput()));
  });

  it('creates version 1 and increments on update (a management control, updatable)', async () => {
    const admin = rewardAdmin(tenantMain);
    const first: RewardPolicy = await setRewardPolicy(admin, policyInput());
    expect(first.version).toBe(1);
    expect(first.qualifyingStatuses).toEqual(['validated', 'measured']);
    expect(first.tiers.map((tier) => tier.minValueScore)).toEqual([0.25, 0.5, 0.75]);
    expect(first.updatedByPrincipal).toBe(admin.principalId);
    expect(Date.parse(first.createdAt)).not.toBeNaN();
    expect(Date.parse(first.updatedAt)).not.toBeNaN();

    const second = await setRewardPolicy(admin, policyInput({ note: 'tightened' }));
    expect(second.version).toBe(2);
    expect(second.note).toBe('tightened');
    expect(Date.parse(second.updatedAt)).toBeGreaterThanOrEqual(Date.parse(first.updatedAt));
    const reread = await getRewardPolicy(member(tenantMain));
    expect(reread?.version).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// The full acquisition-plan flow (the §7 → §8 chain, seeded end to end)
// ---------------------------------------------------------------------------

describe('applyRewardPolicy (acquisition-plan anchor, default gated matrix)', () => {
  it('derives contributor and mission, computes the tier, gates the grant and records the reward', async () => {
    const ctx = member(tenantMain);
    const employee = await askableEmployee(tenantMain, 'Ada Lovelace');
    const mission = await seedMission(ctx, {
      candidateSources: [{ kind: 'person', id: employee.id, label: 'VP Customer Success' }],
    });
    const anchor = await answeredAskPlan(
      ctx,
      employee.id,
      'VP Customer Success',
      mission.id,
    );

    const { assessment, reward } = await applyRewardPolicy(ctx, {
      contribution: { kind: 'acquisition-plan', id: anchor.planId },
      value: valuableValue() as unknown as rewardsContract.ContributionValue,
      actor: { kind: 'system', label: 'aurum-cognition' },
      rationale: 'mission resolved by this answer',
    });

    // The deterministic conversion (policy defaults: 0.4/0.4/0.2 weights).
    expect(assessment.decision).toBe('reward_due');
    expect(assessment.valueScore).toBe(0.66);
    expect(assessment.tier?.name).toBe('thank-you-gift');

    expect(reward).not.toBeNull();
    const record: Reward = reward!;
    // Contributor + mission DERIVED from the validated plan, never trusted.
    expect(record.contribution).toEqual({
      kind: 'acquisition-plan',
      id: anchor.planId,
      label: null,
    });
    expect(record.contributor).toEqual({ personId: employee.id, label: 'VP Customer Success' });
    expect(record.missionId).toBe(mission.id);
    expect(record.missionVersion).toBe(mission.version);
    expect(record.missionRewardBudget).toEqual({ amount: 100_00, currency: 'EUR' });
    expect(record.missionRewardTerms).toBe('A thank-you gift for qualifying contributions.');
    // The §8 value snapshot round-trips.
    expect(record.value.status).toBe('measured');
    expect(record.value.knowledgeGain).toBe(0.4);
    expect(record.value.missionImpact).toBe('resolved');
    expect(record.value.costAvoided).toEqual({ amount: 250_00, currency: 'EUR' });
    expect(record.value.affectedGoals).toHaveLength(1);
    // The configured reward comes from the matched tier only.
    expect(record.tier).toEqual({
      name: 'thank-you-gift',
      minValueScore: 0.5,
      kind: 'gift',
      amount: 50_00,
      currency: 'EUR',
    });
    expect(record.valueScore).toBe(0.66);
    expect(record.assessment).toEqual(assessment);
    expect(record.policyVersion).toBe(2); // the current policy of tenantMain
    expect(record.policySnapshot.version).toBe(2);
    expect(record.policySnapshot.matchedTierFloor).toBe(0.5);
    // The default matrix approval-gates EXECUTE ⇒ proposed, with the
    // evaluation snapshot persisted.
    expect(record.status).toBe('proposed');
    expect(record.authority).toEqual({ outcome: 'approval_required', resolvedVia: 'built-in' });
    // Budget accounting: nothing committed before, this reward commits 50.
    expect(record.budgetRemainingBefore).toBe(100_00);
    // Audit quartet.
    expect(record.actor).toEqual({ kind: 'system', id: null, label: 'aurum-cognition' });
    expect(record.appliedByPrincipal).toBe(ctx.principalId);
    expect(record.rationale).toBe('mission resolved by this answer');
    expect(Date.parse(record.recordedAt)).not.toBeNaN();
    expect(record.settlement).toBeNull();
    // Compensation separation: no compensation/performance field exists.
    expect(Object.keys(record).sort()).not.toContain('salary');
    expect(Object.keys(record).sort()).not.toContain('performanceRating');

    // The gate request exists in the actions module and carries the
    // deterministic justification + payload.
    const request = await getActionRequest(ctx, { requestId: record.actionRequestId });
    expect(request.actionKind).toBe('contribution-reward');
    expect(request.authorityLevel).toBe('EXECUTE');
    expect(request.status).toBe('pending');
    expect(request.requestedBy).toBe(ctx.principalId);
    expect(request.idempotencyKey).toBe(`contribution-reward:acquisition-plan:${anchor.planId}`);
    expect(JSON.stringify(request.payload)).toContain('thank-you-gift');
  });

  it('cross-checks a caller-supplied missionId against the plan mission', async () => {
    const ctx = member(tenantMain);
    const employee = await askableEmployee(tenantMain, 'Grace Hopper');
    const mission = await seedMission(ctx, {
      candidateSources: [{ kind: 'person', id: employee.id }],
    });
    const anchor = await answeredAskPlan(ctx, employee.id, 'Engineer', mission.id);
    await expectCode('invalid_reward_input', () =>
      applyRewardPolicy(ctx, {
        contribution: { kind: 'acquisition-plan', id: anchor.planId },
        missionId: newId(), // not the plan's mission
        value: valuableValue() as unknown as rewardsContract.ContributionValue,
        actor: { kind: 'system', label: 'aurum-cognition' },
      }),
    );
  });

  it('applies the same flow for a knowledge-contribution reference (the W042 wiring surface)', async () => {
    const ctx = member(tenantMain);
    const employee = await askableEmployee(tenantMain, 'Alan Turing');
    const mission = await seedMission(ctx);
    const { reward } = await applyRewardPolicy(
      ctx,
      knowledgeContributionApplication(mission.id, employee.id),
    );
    expect(reward).not.toBeNull();
    expect(reward!.contribution.kind).toBe('knowledge-contribution');
    expect(reward!.contributor.personId).toBe(employee.id);
    expect(reward!.missionId).toBe(mission.id);
    expect(reward!.status).toBe('proposed');
  });
});

// ---------------------------------------------------------------------------
// No reward due — nothing recorded
// ---------------------------------------------------------------------------

describe('applyRewardPolicy (no reward due)', () => {
  it('returns the deterministic assessment and records nothing for non-qualifying values', async () => {
    const admin = rewardAdmin(tenantNoDue);
    await setRewardPolicy(admin, policyInput());
    const ctx = member(tenantNoDue);
    const mission = await seedMission(ctx);
    const employee = await askableEmployee(tenantNoDue, 'No Reward');

    const rejected = await applyRewardPolicy(
      ctx,
      knowledgeContributionApplication(mission.id, employee.id, { status: 'rejected' }),
    );
    expect(rejected.assessment.decision).toBe('no_reward_due');
    expect(rejected.assessment.reason).toBe('non_qualifying_status');
    expect(rejected.reward).toBeNull();

    const belowFloor = await applyRewardPolicy(
      ctx,
      knowledgeContributionApplication(mission.id, employee.id, {
        knowledgeGain: 0.1,
        missionImpact: 'advanced',
        costAvoided: { amount: 0, currency: 'EUR' },
      }),
    );
    // 0.4*0.1 + 0.4*0.6 + 0 = 0.28 — above the 0.25 floor, actually due.
    expect(belowFloor.assessment.decision).toBe('reward_due');
    const trulyBelow = await applyRewardPolicy(
      ctx,
      knowledgeContributionApplication(mission.id, employee.id, {
        knowledgeGain: 0.1,
        missionImpact: 'no_effect',
        costAvoided: { amount: 0, currency: 'EUR' },
      }),
    );
    expect(trulyBelow.assessment.decision).toBe('no_reward_due');
    expect(trulyBelow.assessment.reason).toBe('below_tier_floor');
    expect(trulyBelow.assessment.valueScore).toBe(0.04);
    expect(trulyBelow.reward).toBeNull();

    // Nothing was recorded beyond the one due reward: no stray gate
    // requests for the not-due applications.
    await expect(summarizeRewards(ctx, {})).resolves.toMatchObject({ totalRewards: 1 });
    const { listActionRequests } = await import('@/modules/actions/contract');
    expect((await listActionRequests(ctx, { actionKind: 'contribution-reward' })).length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Authority gate outcomes (the W009 dependency, end to end)
// ---------------------------------------------------------------------------

describe('authority gate outcomes', () => {
  it('auto-grants when the tenant matrix allows EXECUTE of contribution-reward', async () => {
    // The tenant relaxes its matrix explicitly (actions:administer).
    await setAuthorityPolicy(actionsAdmin(tenantAuto), {
      actionKind: 'contribution-reward',
      approvalLevels: [],
      forbiddenLevels: [],
    });
    const admin = rewardAdmin(tenantAuto);
    await setRewardPolicy(admin, policyInput());
    const ctx = member(tenantAuto);
    const employee = await askableEmployee(tenantAuto, 'Auto Granted');
    const mission = await seedMission(ctx);

    const { reward } = await applyRewardPolicy(
      ctx,
      knowledgeContributionApplication(mission.id, employee.id),
    );
    expect(reward!.status).toBe('granted'); // minted directly by policy
    expect(reward!.authority).toEqual({ outcome: 'allowed', resolvedVia: 'kind' });
    expect(reward!.settlement).toBeNull(); // nothing to settle
    await expectCode('reward_not_proposed', () =>
      settleReward(ctx, { rewardId: reward!.id }),
    );
  });

  it('refuses (and retains the refusal) when the tenant matrix forbids it', async () => {
    await setAuthorityPolicy(actionsAdmin(tenantForbidden), {
      actionKind: 'contribution-reward',
      forbiddenLevels: ['EXECUTE'],
    });
    const admin = rewardAdmin(tenantForbidden);
    await setRewardPolicy(admin, policyInput());
    const ctx = member(tenantForbidden);
    const employee = await askableEmployee(tenantForbidden, 'Refused');
    const mission = await seedMission(ctx);
    const application = knowledgeContributionApplication(mission.id, employee.id);
    const { reward } = await applyRewardPolicy(ctx, application);
    expect(reward!.status).toBe('refused');
    expect(reward!.authority).toEqual({ outcome: 'forbidden', resolvedVia: 'kind' });
    // The refusal is retained evidence; re-application conflicts.
    await expectCode('reward_conflict', () => applyRewardPolicy(ctx, application));
  });

  it('settles a gated reward from the recorded human decision (approved → granted)', async () => {
    const admin = rewardAdmin(tenantSettle);
    await setRewardPolicy(admin, policyInput());
    const ctx = member(tenantSettle);
    const employee = await askableEmployee(tenantSettle, 'Settled');
    const mission = await seedMission(ctx);
    const { reward } = await applyRewardPolicy(
      ctx,
      knowledgeContributionApplication(mission.id, employee.id),
    );
    const record = reward!;

    // Settling before a human decision is refused.
    await expectCode('reward_still_proposed', () =>
      settleReward(ctx, { rewardId: record.id }),
    );

    // The requesting principal can never decide its own gate (actions'
    // separation of duties) — an authorized OTHER human decides.
    const human = approver(tenantSettle);
    await expect(decideApproval(ctx, { requestId: record.actionRequestId, decision: 'approve' })).rejects.toThrow();
    await decideApproval(human, { requestId: record.actionRequestId, decision: 'approve' });

    const settled = await settleReward(ctx, { rewardId: record.id });
    expect(settled.status).toBe('granted');
    expect(settled.settlement).not.toBeNull();
    expect(settled.settlement!.decision).toBe('granted');
    expect(settled.settlement!.decidedByPrincipal).toBe(human.principalId);
    expect(Date.parse(settled.settlement!.decidedAt!)).not.toBeNaN();
    expect(settled.settlement!.settledByPrincipal).toBe(ctx.principalId);
    expect(Date.parse(settled.settlement!.settledAt)).not.toBeNaN();

    // First settlement wins; a second settle reports the terminal state.
    await expectCode('reward_already_settled', () => settleReward(ctx, { rewardId: record.id }));

    // The read model reflects the derived status.
    await expect(getReward(ctx, record.id)).resolves.toMatchObject({ status: 'granted' });
  });

  it('settles a gated reward as declined when the human rejects it (budget freed)', async () => {
    const admin = rewardAdmin(tenantSettle);
    await setRewardPolicy(admin, policyInput());
    const ctx = member(tenantSettle);
    const employee = await askableEmployee(tenantSettle, 'Declined');
    const mission = await seedMission(ctx);
    const { reward } = await applyRewardPolicy(
      ctx,
      knowledgeContributionApplication(mission.id, employee.id),
    );
    await decideApproval(approver(tenantSettle), {
      requestId: reward!.actionRequestId,
      decision: 'reject',
    });
    const settled = await settleReward(ctx, { rewardId: reward!.id });
    expect(settled.status).toBe('declined');
    expect(settled.settlement!.decision).toBe('declined');
    // The declined reward frees its budget commitment (see the budget
    // describe below for the accounting proof).
    const summary = await summarizeRewards(ctx, { missionId: mission.id });
    expect(summary.committedByCurrency).toEqual([]); // nothing committed
  });
});

// ---------------------------------------------------------------------------
// Mission reward budget + currencies
// ---------------------------------------------------------------------------

describe('mission reward budget and currencies', () => {
  it('caps committed rewards at the mission reward budget and frees them on decline', async () => {
    const admin = rewardAdmin(tenantBudget);
    // Two 50_00 tiers against a 100_00 budget.
    await setRewardPolicy(admin, policyInput());
    const ctx = member(tenantBudget);
    const employee = await askableEmployee(tenantBudget, 'Budget One');
    const employee2 = await askableEmployee(tenantBudget, 'Budget Two');
    const mission = await seedMission(ctx, { rewardBudget: { amount: 100_00, currency: 'EUR' } });

    const first = (await applyRewardPolicy(
      ctx,
      knowledgeContributionApplication(mission.id, employee.id),
    )).reward!;
    expect(first.budgetRemainingBefore).toBe(100_00);

    // A second 50_00 reward fits exactly.
    const second = (await applyRewardPolicy(
      ctx,
      knowledgeContributionApplication(mission.id, employee2.id),
    )).reward!;
    expect(second.budgetRemainingBefore).toBe(50_00);

    // A third would over-commit the budget.
    await expectCode('budget_exceeded', () =>
      applyRewardPolicy(ctx, knowledgeContributionApplication(mission.id, employee.id)),
    );

    // Declining the second frees its commitment: the third now fits.
    await decideApproval(approver(tenantBudget), {
      requestId: second.actionRequestId,
      decision: 'reject',
    });
    await settleReward(ctx, { rewardId: second.id });
    const third = (await applyRewardPolicy(
      ctx,
      knowledgeContributionApplication(mission.id, employee.id, { missionImpact: 'advanced' }),
    )).reward!;
    expect(third.budgetRemainingBefore).toBe(50_00);

    const summary = await summarizeRewards(ctx, { missionId: mission.id });
    expect(summary.totalRewards).toBe(3);
    expect(summary.byStatus).toEqual({ proposed: 2, granted: 0, declined: 1, refused: 0 });
    expect(summary.committedByCurrency).toEqual([{ currency: 'EUR', count: 2, amount: 100_00 }]);
  });

  it('rejects currency mismatches uniformly (mission budget and cost avoided)', async () => {
    const admin = rewardAdmin(tenantBudget);
    await setRewardPolicy(admin, policyInput({ rewardCurrency: 'USD' }));
    const ctx = member(tenantBudget);
    const employee = await askableEmployee(tenantBudget, 'Mixed Currency');
    const mission = await seedMission(ctx, { rewardBudget: { amount: 100_00, currency: 'EUR' } });

    await expectCode('currency_mismatch', () =>
      applyRewardPolicy(ctx, knowledgeContributionApplication(mission.id, employee.id)),
    );

    // Matching budget currency but a foreign-denominated cost figure.
    await setRewardPolicy(admin, policyInput());
    await expectCode('currency_mismatch', () =>
      applyRewardPolicy(
        ctx,
        knowledgeContributionApplication(mission.id, employee.id, {
          costAvoided: { amount: 100_00, currency: 'USD' },
        }),
      ),
    );
  });

  it('refuses to reward against an abandoned mission (dead budget)', async () => {
    const admin = rewardAdmin(tenantBudget);
    await setRewardPolicy(admin, policyInput());
    const ctx = member(tenantBudget);
    const employee = await askableEmployee(tenantBudget, 'Abandoned');
    const mission = await seedMission(ctx);
    await abandonMission(ctx, {
      missionId: mission.id,
      reason: 'superseded',
      actor: { kind: 'person', label: 'COO' },
    });
    await expectCode('mission_not_rewardable', () =>
      applyRewardPolicy(ctx, knowledgeContributionApplication(mission.id, employee.id)),
    );
  });

  it('rewards against a completed mission (the resolving contribution lands after completion)', async () => {
    const admin = rewardAdmin(tenantBudget);
    await setRewardPolicy(admin, policyInput());
    const ctx = member(tenantBudget);
    const employee = await askableEmployee(tenantBudget, 'Completed');
    const mission = await seedMission(ctx);
    await completeMission(ctx, {
      missionId: mission.id,
      achievedConfidence: 0.9,
      outcome: 'root cause identified',
      actor: { kind: 'person', label: 'COO' },
    });
    const { reward } = await applyRewardPolicy(
      ctx,
      knowledgeContributionApplication(mission.id, employee.id),
    );
    expect(reward!.status).toBe('proposed');
    expect(reward!.missionVersion).toBe(mission.version + 1); // the completed version
  });

  it('one reward per contribution — re-application conflicts', async () => {
    const admin = rewardAdmin(tenantBudget);
    await setRewardPolicy(admin, policyInput());
    const ctx = member(tenantBudget);
    const employee = await askableEmployee(tenantBudget, 'Once Only');
    const mission = await seedMission(ctx);
    const application = knowledgeContributionApplication(mission.id, employee.id);
    const first = await applyRewardPolicy(ctx, application);
    expect(first.reward).not.toBeNull();
    await expectCode('reward_conflict', () => applyRewardPolicy(ctx, application));
  });
});

// ---------------------------------------------------------------------------
// Contribution anchor validation
// ---------------------------------------------------------------------------

describe('contribution anchor validation (uniform invalid_contribution_ref)', () => {
  it('rejects unanswered, no-candidate and foreign-tenant plan anchors without leaking', async () => {
    const admin = rewardAdmin(tenantAnchor);
    await setRewardPolicy(admin, policyInput());
    const ctx = member(tenantAnchor);

    // A planned but UNANSWERED ask-person plan.
    const employee = await askableEmployee(tenantAnchor, 'Anchor One');
    const mission = await seedMission(ctx, {
      candidateSources: [{ kind: 'person', id: employee.id }],
    });
    const plan = await planNextAcquisition(ctx, {
      missionId: mission.id,
      candidates: [
        {
          kind: 'person',
          id: employee.id,
          relevance: 0.9,
          reliability: 0.9,
          freshness: 0.9,
          authority: 0.9,
          expectedQuality: 0.9,
          priorContributionValue: 0.5,
          cost: 0,
          access: 'allowed',
        },
      ],
      actor: { kind: 'system', label: 'aurum-cognition' },
    });
    await expectCode('invalid_contribution_ref', () =>
      applyRewardPolicy(ctx, {
        contribution: { kind: 'acquisition-plan', id: plan.id },
        value: valuableValue() as unknown as rewardsContract.ContributionValue,
        actor: { kind: 'system', label: 'aurum-cognition' },
      }),
    );

    // A no-candidate plan (nothing was asked).
    const emptyMission = await seedMission(ctx, {
      candidateSources: [{ kind: 'system', label: 'billing-export' }],
    });
    const noCandidate = await planNextAcquisition(ctx, {
      missionId: emptyMission.id,
      candidates: [
        {
          kind: 'system',
          label: 'billing-export',
          relevance: 0.1,
          reliability: 0.1,
          freshness: 0.1,
          authority: 0.1,
          expectedQuality: 0.1,
          priorContributionValue: 0,
          cost: 0,
          access: 'forbidden',
        },
      ],
      actor: { kind: 'system', label: 'aurum-cognition' },
    });
    expect(noCandidate.decision).toBe('no_candidate');
    await expectCode('invalid_contribution_ref', () =>
      applyRewardPolicy(ctx, {
        contribution: { kind: 'acquisition-plan', id: noCandidate.id },
        value: valuableValue() as unknown as rewardsContract.ContributionValue,
        actor: { kind: 'system', label: 'aurum-cognition' },
      }),
    );

    // A foreign-tenant plan id reads exactly like a missing one (no leak):
    // build a real answered plan in ANOTHER tenant first.
    const otherCtx = member(tenantMain);
    const otherEmployee = await askableEmployee(tenantMain, 'Other Tenant Anchor');
    const otherMission = await seedMission(otherCtx, {
      candidateSources: [{ kind: 'person', id: otherEmployee.id }],
    });
    const otherAnchor = await answeredAskPlan(
      otherCtx,
      otherEmployee.id,
      'Other',
      otherMission.id,
    );
    expect(otherAnchor.planId).toBeTruthy();
    await expectCode('invalid_contribution_ref', () =>
      applyRewardPolicy(ctx, {
        contribution: { kind: 'acquisition-plan', id: otherAnchor.planId },
        value: valuableValue() as unknown as rewardsContract.ContributionValue,
        actor: { kind: 'system', label: 'aurum-cognition' },
      }),
    );
    // A malformed id is rejected by input validation (no leak — it never
    // reaches storage and reveals nothing about existence).
    await expectCode('invalid_reward_input', () =>
      applyRewardPolicy(ctx, {
        contribution: { kind: 'acquisition-plan', id: 'not-a-uuid' },
        value: valuableValue() as unknown as rewardsContract.ContributionValue,
        actor: { kind: 'system', label: 'aurum-cognition' },
      } as unknown as rewardsContract.ApplyRewardPolicyInput),
    );
  });

  it('rejects a foreign-tenant mission uniformly (no existence leak)', async () => {
    const admin = rewardAdmin(tenantAnchor);
    await setRewardPolicy(admin, policyInput());
    const ctx = member(tenantAnchor);
    const employee = await askableEmployee(tenantAnchor, 'Anchor Two');
    // A mission that exists in tenantMain, read from tenantAnchor.
    const otherCtx = member(tenantMain);
    const otherMission = await seedMission(otherCtx);
    await expectCode('mission_not_found', () =>
      applyRewardPolicy(
        ctx,
        knowledgeContributionApplication(otherMission.id, employee.id),
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// Compensation separation at the storage layer
// ---------------------------------------------------------------------------

describe('compensation separation at the storage layer', () => {
  it('rejects a compensation-shaped reward kind on a raw insert (CHECK constraint)', async () => {
    const db = getDb();
    await expect(
      db.query(
        `INSERT INTO rewards (
           tenant_id, contribution_kind, contribution_id,
           contributor_person_id, mission_id, mission_version,
           mission_reward_budget_amount, mission_reward_budget_currency,
           contribution_status, knowledge_gain, mission_impact_kind, affected_goals,
           cost_avoided_amount, cost_avoided_currency, value_score,
           reward_kind, reward_amount, reward_currency, tier_name,
           policy_version, policy_snapshot, value_assessment, status,
           authority_outcome, authority_source, action_request_id, budget_remaining_before,
           actor_kind, actor_label, applied_by_principal, recorded_at
         ) VALUES ($1, 'knowledge-contribution', $2, $3, $4, 1,
                   10000, 'EUR', 'measured', 0.4, 'resolved', '[]'::jsonb,
                   0, 'EUR', 0.66, 'salary', 50000, 'EUR', 'raise',
                   1, '{}'::jsonb, '{}'::jsonb, 'proposed',
                   'approval_required', 'built-in', $5, 10000,
                   'system', 'test', 'test', now())`,
        [tenantComp, newId(), newId(), newId(), newId()],
      ),
    ).rejects.toThrow(/reward_kind/i);
  });
});

// ---------------------------------------------------------------------------
// Append-only storage
// ---------------------------------------------------------------------------

describe('append-only storage', () => {
  it('rejects UPDATE/DELETE/TRUNCATE on rewards and reward_settlements (triggers)', async () => {
    const admin = rewardAdmin(tenantComp);
    await setRewardPolicy(admin, policyInput());
    const ctx = member(tenantComp);
    const employee = await askableEmployee(tenantComp, 'Immutable');
    const mission = await seedMission(ctx);
    const { reward } = await applyRewardPolicy(
      ctx,
      knowledgeContributionApplication(mission.id, employee.id),
    );
    const rewardId = reward!.id;
    const db = getDb();

    await expect(db.query(`UPDATE rewards SET rationale = 'rewritten' WHERE id = $1`, [rewardId])).rejects.toThrow(/append-only/);
    await expect(db.query(`DELETE FROM rewards WHERE id = $1`, [rewardId])).rejects.toThrow(/append-only/);
    // On rewards the settlement FK may fire before the trigger — either
    // rejection proves the table cannot be silently emptied.
    await expect(db.query(`TRUNCATE rewards`)).rejects.toThrow(/append-only|cannot truncate/);

    await decideApproval(approver(tenantComp), {
      requestId: reward!.actionRequestId,
      decision: 'approve',
    });
    await settleReward(ctx, { rewardId });
    await expect(db.query(`UPDATE reward_settlements SET decision = 'declined' WHERE reward_id = $1`, [rewardId])).rejects.toThrow(/append-only/);
    await expect(db.query(`DELETE FROM reward_settlements WHERE reward_id = $1`, [rewardId])).rejects.toThrow(/append-only/);
    await expect(db.query(`TRUNCATE reward_settlements`)).rejects.toThrow(/append-only/);
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation
// ---------------------------------------------------------------------------

describe('tenant isolation (ADR-0001)', () => {
  it('never exposes another tenant\'s rewards, policies or settlements', async () => {
    const admin = rewardAdmin(tenantIso);
    await setRewardPolicy(admin, policyInput());
    const ctxA = member(tenantIso);
    const employee = await askableEmployee(tenantIso, 'Isolated');
    const mission = await seedMission(ctxA);
    const { reward } = await applyRewardPolicy(
      ctxA,
      knowledgeContributionApplication(mission.id, employee.id),
    );
    const rewardId = reward!.id;

    // Tenant B has no policy configured and sees nothing of tenant A.
    const ctxB = member(tenantReads);
    await expect(getRewardPolicy(ctxB)).resolves.toBeNull();
    await expectCode('policy_not_configured', () =>
      applyRewardPolicy(ctxB, knowledgeContributionApplication(mission.id, employee.id)),
    );
    await expectCode('reward_not_found', () => getReward(ctxB, rewardId));
    await expectCode('reward_not_found', () => settleReward(ctxB, { rewardId }));
    await expect(listRewards(ctxB, {})).resolves.toHaveLength(0);
    // Malformed ids stay uniform (no leak through error shape).
    await expectCode('reward_not_found', () => getReward(ctxB, 'not-a-uuid'));
    // Settlements are unrepresentable cross-tenant at the SQL layer too.
    await expect(
      getDb().query(
        `INSERT INTO reward_settlements (tenant_id, reward_id, decision, settled_by_principal)
           VALUES ($1, $2, 'granted', 'intruder')`,
        [tenantReads, rewardId],
      ),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Read surface
// ---------------------------------------------------------------------------

describe('read surface', () => {
  it('round-trips a full reward through getReward', async () => {
    const admin = rewardAdmin(tenantReads);
    await setRewardPolicy(admin, policyInput());
    const ctx = member(tenantReads);
    const employee = await askableEmployee(tenantReads, 'Read Model');
    const mission = await seedMission(ctx);
    const { reward } = await applyRewardPolicy(
      ctx,
      knowledgeContributionApplication(mission.id, employee.id),
    );
    const reread = await getReward(ctx, reward!.id);
    expect(reread).toEqual(reward);
  });

  it('filters listRewards by mission, contributor, kind and derived status', async () => {
    const admin = rewardAdmin(tenantReads);
    await setRewardPolicy(admin, policyInput());
    const ctx = member(tenantReads);
    const employeeA = await askableEmployee(tenantReads, 'Reader A');
    const employeeB = await askableEmployee(tenantReads, 'Reader B');
    const missionOne = await seedMission(ctx);
    const missionTwo = await seedMission(ctx);

    const one = (await applyRewardPolicy(
      ctx,
      knowledgeContributionApplication(missionOne.id, employeeA.id),
    )).reward!;
    const two = (await applyRewardPolicy(
      ctx,
      knowledgeContributionApplication(missionTwo.id, employeeB.id),
    )).reward!;

    // Decide + settle missionOne's reward so the derived status moves.
    await decideApproval(approver(tenantReads), {
      requestId: one.actionRequestId,
      decision: 'approve',
    });
    await settleReward(ctx, { rewardId: one.id });

    expect(await listRewards(ctx, { missionId: missionOne.id })).toHaveLength(1);
    expect((await listRewards(ctx, { missionId: missionTwo.id }))[0]!.id).toBe(two.id);
    expect(await listRewards(ctx, { contributorPersonId: employeeA.id })).toHaveLength(1);
    // The round-trip reward above is also a 'gift' in this tenant.
    expect(await listRewards(ctx, { kind: 'gift' })).toHaveLength(3);
    // Derived statuses: one settled to granted, two still proposed (the
    // round-trip reward above is also still proposed in this tenant).
    expect(
      (await listRewards(ctx, { missionId: missionOne.id, status: 'granted' })).map((r) => r.id),
    ).toEqual([one.id]);
    expect(
      (await listRewards(ctx, { missionId: missionTwo.id, status: 'proposed' })).map((r) => r.id),
    ).toEqual([two.id]);
    expect(await listRewards(ctx, { status: 'declined' })).toHaveLength(0);
    expect(await listRewards(ctx, { status: 'refused' })).toHaveLength(0);
    expect(await listRewards(ctx, { status: 'proposed' })).toHaveLength(2);
    // Latest first.
    expect((await listRewards(ctx, {}))[0]!.id).toBe(two.id);
  });

  it('summarizes statuses, kinds, committed currency totals and contributors', async () => {
    const admin = rewardAdmin(tenantReads);
    await setRewardPolicy(admin, policyInput());
    const ctx = member(tenantReads);
    const employeeA = await askableEmployee(tenantReads, 'Summary A');
    const employeeB = await askableEmployee(tenantReads, 'Summary B');
    const mission = await seedMission(ctx, { rewardBudget: { amount: 200_00, currency: 'EUR' } });

    const one = (await applyRewardPolicy(
      ctx,
      knowledgeContributionApplication(mission.id, employeeA.id),
    )).reward!;
    const two = (await applyRewardPolicy(
      ctx,
      knowledgeContributionApplication(mission.id, employeeB.id),
    )).reward!;
    await decideApproval(approver(tenantReads), {
      requestId: one.actionRequestId,
      decision: 'approve',
    });
    await settleReward(ctx, { rewardId: one.id });
    await decideApproval(approver(tenantReads), {
      requestId: two.actionRequestId,
      decision: 'reject',
    });
    await settleReward(ctx, { rewardId: two.id });

    const summary = await summarizeRewards(ctx, { missionId: mission.id });
    expect(summary.totalRewards).toBe(2);
    expect(summary.byStatus).toEqual({ proposed: 0, granted: 1, declined: 1, refused: 0 });
    expect(summary.byKind).toEqual([
      { kind: 'gift', currency: 'EUR', count: 2, amount: 100_00 },
    ]);
    expect(summary.committedByCurrency).toEqual([
      { currency: 'EUR', count: 1, amount: 50_00 },
    ]);
    expect(summary.contributors).toBe(2);

    // Narrowed by contributor.
    const narrowed = await summarizeRewards(ctx, { contributorPersonId: employeeA.id });
    expect(narrowed.totalRewards).toBe(1);
    expect(narrowed.contributors).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Policy edits never rewrite recorded rewards
// ---------------------------------------------------------------------------

describe('policy edits never rewrite recorded rewards', () => {
  it('keeps the frozen snapshot when the policy moves on', async () => {
    const admin = rewardAdmin(tenantMain);
    const ctx = member(tenantMain);
    const employee = await askableEmployee(tenantMain, 'Snapshot');
    const mission = await seedMission(ctx);
    const before = (await applyRewardPolicy(
      ctx,
      knowledgeContributionApplication(mission.id, employee.id),
    )).reward!;

    // Tighten the policy drastically.
    await setRewardPolicy(admin, policyInput({ minKnowledgeGain: 0.9, note: 'tightened' }));
    const policyNow = await getRewardPolicy(ctx);
    expect(policyNow!.version).toBeGreaterThan(before.policyVersion);

    const reread = await getReward(ctx, before.id);
    expect(reread.policyVersion).toBe(before.policyVersion);
    expect(reread.policySnapshot.minKnowledgeGain).toBe(0);
    expect(reread.tier.amount).toBe(50_00);
    expect(reread.assessment).toEqual(before.assessment);
  });
});
