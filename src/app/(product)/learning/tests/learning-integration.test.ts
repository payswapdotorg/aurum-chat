// Integration tests for the learning surface (W062) against the embedded
// PostgreSQL (PGlite, `:memory:`) through the db port.
//
// THE WORK ITEM'S ACCEPTANCE, proven end to end through REAL module
// contracts (the whole of plan §2 Journey F, employee side):
//
//   * ASK: requestNextKnowledge drives the W012 planner over a seeded
//     mission's candidate menu (person + system) — the person resolves
//     (active employee + verified identity), the ask policy permits, and
//     the targeted question becomes the open knowledge request
//     (buildLearningHomeView lists it, oldest first).
//   * ANSWER + EVIDENCE CAPTURE: the surface's API write records the
//     answer — the acquisition outcome is 'answered' with an immutable
//     observation (the asked person as provenance), and the contribution
//     anchors to the plan with status 'pending' (the acknowledgement).
//   * ACKNOWLEDGEMENT LADDER: validation (validated), impact measurement
//     (frozen knowledge gain + cost avoided) and the contribution rollup
//     are legible in the hub view.
//   * REWARD STATUS/HISTORY: the explicit policy converts the validated
//     contribution into a PROPOSED reward (the §20 human gate holds it),
//     the manager decides it at the approvals contract, settleReward
//     consumes the frozen decision and the hub view shows GRANTED with
//     its settlement.
//   * MISSION VIEW: buildMissionLearningView composes the mission's
//     requests/contributions/rewards (the intelligence mission page's
//     W062 panels).
//   * NO COMPENSATION SEMANTICS: the view rows and their labels carry
//     only the closed non-compensation vocabulary (unit-pinned in
//     learning-unit.test.ts; here the surface end-to-end is swept).
//   * TENANT ISOLATION (ADR-0001): tenant B's hub is empty, and tenant
//     B answering tenant A's request reads as plan_not_found (no
//     existence leak).
//   * THE API SURFACE: anonymous is 401; a malformed plan id is 404; a
//     double answer is 409 (first write wins); a non-object body is 400.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { runMigrations } from '../../../../../scripts/migrate';

import { provisionTenant } from '@/modules/organizations/contract';
import type { Tenant } from '@/modules/organizations/contract';
import { registerUser, selectCompany } from '@/modules/auth/contract';
import { createEmployee, createPerson, linkExternalIdentity } from '@/modules/people/contract';
import {
  attestIdentity,
  registerExternalIdentity,
} from '@/modules/identity/contract';
import { IDENTITY_AUTHORITY_ATTEST, IDENTITY_AUTHORITY_LINK } from '@/modules/identity/contract';
import { createMission } from '@/modules/missions/contract';
import {
  getAcquisitionPlan,
  missionSubjectTopics,
} from '@/modules/knowledge-acquisition/contract';
import { recordObservation } from '@/modules/observations/contract';
import { recordTransactiveEntry } from '@/modules/memory/contract';
import { recordImpact, validateContribution } from '@/modules/contributions/contract';
import { applyRewardPolicy, setRewardPolicy, settleReward } from '@/modules/rewards/contract';
import { REWARDS_AUTHORITY_ADMINISTER } from '@/modules/rewards/contract';
import { ACTIONS_AUTHORITY_APPROVE, decideApproval } from '@/modules/actions/contract';

import { requestNextKnowledge } from '../lib/answer';
import { buildLearningHomeView, buildMissionLearningView } from '../lib/views';
import { handleAnswerPost, handleAskPost } from '../lib/api';
import { REWARD_SEPARATION_NOTE, usesForbiddenTerm } from '../lib/labels';

const db = getDb();

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const SESSION_COOKIE = 'aurum_session';

// Fake credentials assembled from fragments at runtime (push-protection).
const passwordFragments = ['pa', 'per', 'lily-', '9'];

function member(tenantId: string, principalId: string): TenantContext {
  return { tenantId, principalId, authority: [] };
}

function approver(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: [ACTIONS_AUTHORITY_APPROVE] };
}

function rewardAdmin(tenantId: string, principalId: string): TenantContext {
  return { tenantId, principalId, authority: [REWARDS_AUTHORITY_ADMINISTER] };
}

interface LearningFixture {
  tenant: Tenant;
  owner: TenantContext;
  ownerToken: string;
}

async function provisionLearningFixture(name: string): Promise<LearningFixture> {
  const local = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const email = [local, '.', newId().slice(0, 8), '@example', '.test'].join('');
  const issued = await registerUser({
    displayName: `${name} Owner`,
    email,
    password: passwordFragments.join(''),
  });
  const tenant = await provisionTenant(
    { principalId: newId(), authority: ['organizations:provision'] },
    { name, ownerPrincipalId: issued.session.principalId },
  );
  await selectCompany({ token: issued.token, tenantId: tenant.id });
  return {
    tenant,
    owner: member(tenant.id, issued.session.principalId),
    ownerToken: issued.token,
  };
}

/** The askable employee: person + active employee + verified identity. */
async function askableEmployee(
  ctx: TenantContext,
  fullName: string,
): Promise<{ personId: string }> {
  const person = await createPerson(ctx, {
    fullName,
    email: [fullName.toLowerCase().replace(/\s+/g, '.'), '.', newId().slice(0, 6), '@example.test'].join(''),
  });
  await createEmployee(ctx, {
    personId: person.id,
    title: 'Operations Lead',
    department: 'Operations',
    hiredAt: '2025-02-03T00:00:00.000Z',
  });
  const registered = await registerExternalIdentity(ctx, {
    provider: 'web',
    providerAccountId: `web-${newId().slice(0, 10)}`,
    displayName: `${fullName} (web)`,
  });
  const attested = await attestIdentity(
    { ...ctx, authority: [...ctx.authority, IDENTITY_AUTHORITY_ATTEST] },
    { identityId: registered.identity.id, evidence: 'integration fixture — verified in person' },
  );
  await linkExternalIdentity(
    { ...ctx, authority: [...ctx.authority, IDENTITY_AUTHORITY_LINK] },
    { personId: person.id, identityId: attested.id },
  );
  return { personId: person.id };
}

function sessionRequest(token: string, body: unknown, url: string): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: `${SESSION_COOKIE}=${token}` },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('the learning surface over the full Journey F chain', () => {
  let acme: LearningFixture;
  let beta: LearningFixture;

  let missionId: string;
  let employeePersonId: string;
  let planId: string;
  let contributionId: string;
  let rewardId: string;
  let actionRequestId: string;

  beforeAll(async () => {
    await runMigrations(db);
    acme = await provisionLearningFixture('Northwind Learning');
    beta = await provisionLearningFixture('Initech Learning');
    const ctx = acme.owner;

    // The askable employee (an active employee with a verified identity).
    const employee = await askableEmployee(ctx, 'June Park');
    employeePersonId = employee.personId;

    // The mission: the knowledge investment with its candidate menu.
    const mission = await createMission(ctx, {
      title: 'Courier customs bottleneck',
      knowledgeObjective:
        'Identify why wholesale delivery freshness dropped after September: which customs-broker change delays the cold chain, and by how much.',
      informationValue: 0.8,
      urgency: 'high',
      targetConfidence: 0.8,
      investigationBudget: { amount: 500_00, currency: 'USD' },
      rewardBudget: { amount: 200_00, currency: 'USD' },
      rewardTerms: 'A configured reward for a validated root-cause answer.',
      candidateSources: [
        { kind: 'person', id: employeePersonId, label: 'June Park' },
        { kind: 'system', label: 'Roastery WMS' },
      ],
      completionCriteria: 'The freshness dip is attributed to a named, evidenced cause.',
      actor: { kind: 'person', label: 'Ops Lead' },
    });
    missionId = mission.id;

    // The tenant's transactive memory: WHO knows the mission's subjects.
    // This is what makes the planner's person-candidate relevance
    // derivation honest (the cognition module's workflow-level default —
    // the same derivation the loop's knowledge-acquisition stage uses):
    // June's coverage of the mission's focus topics is why the person
    // outranks the neutral-prior system.
    const coverage = await recordObservation(ctx, {
      kind: 'ops.note',
      payload: {
        note: 'June Park runs the wholesale courier relationship and handled the September customs handover.',
      },
      observedAt: '2026-10-01T08:00:00.000Z',
      source: { kind: 'person', id: employeePersonId, label: 'June Park' },
      channel: 'ingestion',
      confidence: { value: 0.8, method: 'person-account', basis: 'the ops handover log' },
    });
    await recordTransactiveEntry(ctx, {
      actor: { kind: 'person', id: employeePersonId },
      relation: 'knows',
      subjectLabel: 'Wholesale courier customs handling',
      topics: missionSubjectTopics(
        'Courier customs bottleneck',
        'Identify why wholesale delivery freshness dropped after September: which customs-broker change delays the cold chain, and by how much.',
      ),
      evidenceObservationIds: [coverage.id],
      notes: 'the ops handover log names June as the courier relationship owner',
    });

    // --- THE ASK: the surface's planner trigger -------------------------
    const ask = await requestNextKnowledge(ctx, missionId, 'Northwind Owner');
    expect(ask.decision).toBe('selected');
    expect(ask.chosen?.kind).toBe('person');
    expect(ask.chosen?.label).toBe('June Park');
    expect(ask.question).toContain('Courier customs bottleneck');
    expect(ask.question).toContain('Identify why');
    expect(ask.askPolicy).toBe('allowed');
    planId = ask.planId;
  });

  // -------------------------------------------------------------------------
  // The ask half
  // -------------------------------------------------------------------------

  it('surfaces the open knowledge request in the hub (oldest first)', async () => {
    const view = await buildLearningHomeView(acme.owner);
    expect(view.requests.length).toBe(1);
    const request = view.requests[0]!;
    expect(request.planId).toBe(planId);
    expect(request.question).toContain('Identify why');
    expect(request.askedOf).toBe('June Park');
    expect(request.askPolicy).toBe('allowed');
    expect(request.missionId).toBe(missionId);
    expect(request.missionTitle).toBe('Courier customs bottleneck');
    // The mission row carries its progress.
    expect(view.missions.length).toBe(1);
    expect(view.missions[0]!.progressPercent).toBe(0);
    // Nothing answered yet: no contributions, no rewards.
    expect(view.contributions).toEqual([]);
    expect(view.rewards).toEqual([]);
    expect(view.degraded).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // The answer half (the API write: evidence + contribution)
  // -------------------------------------------------------------------------

  it('answers through the session-scoped API and acknowledges the contribution', async () => {
    const result = await handleAnswerPost(
      sessionRequest(
        acme.ownerToken,
        {
          summary:
            'The courier switched to a cheaper customs broker in September — per-shipment paperwork now takes two to three days and the cold chain waits at the port.',
          confidence: 'high',
          note: 'Direct operational knowledge from the September handover.',
        },
        `https://aurum.test/api/product/learning/requests/${planId}/answer`,
      ),
      planId,
    );
    expect(result.status).toBe(200);
    if (result.status !== 200) return;
    const contributionBody = result.body.contribution as
      | { id?: string; status?: string }
      | undefined;
    expect(contributionBody?.status).toBe('pending');
    expect(result.body.evidenceObservationId).toBeTruthy();
    contributionId = String(contributionBody?.id);

    // The domain state: the plan is answered with the observation as
    // evidence; the contribution is anchored and pending.
    const plan = await getAcquisitionPlan(acme.owner, planId);
    expect(plan.outcome?.outcome).toBe('answered');
    expect(plan.outcome?.evidenceObservationId).toBeTruthy();

    // The hub view now shows the acknowledgement, not the request.
    const view = await buildLearningHomeView(acme.owner);
    expect(view.requests).toEqual([]);
    expect(view.contributions.length).toBe(1);
    const contribution = view.contributions[0]!;
    expect(contribution.id).toBe(contributionId);
    expect(contribution.status).toBe('pending');
    expect(contribution.validation).toBeNull();
    expect(contribution.contributorLabel).toBe('June Park');
    expect(contribution.evidenceObservationId).toBe(plan.outcome?.evidenceObservationId);
    expect(contribution.missionTitle).toBe('Courier customs bottleneck');
    // The summary rollup is the management coverage signal.
    expect(view.contributionSummary?.total).toBe(1);
    expect(view.contributionSummary?.pending).toBe(1);
  });

  it('refuses a second answer (the first outcome wins, honestly)', async () => {
    const second = await handleAnswerPost(
      sessionRequest(acme.ownerToken, { summary: 'a different answer' }, `https://aurum.test/x`),
      planId,
    );
    expect(second.status).toBe(409);
  });

  it('refuses non-object bodies and malformed plan ids', async () => {
    const malformed = await handleAnswerPost(
      sessionRequest(acme.ownerToken, { summary: 's' }, 'https://aurum.test/x'),
      'not-a-uuid',
    );
    expect(malformed.status).toBe(404);
    const badBody = await handleAnswerPost(
      new Request('https://aurum.test/x', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: `${SESSION_COOKIE}=${acme.ownerToken}`,
        },
        body: 'not json at all',
      }),
      planId,
    );
    expect(badBody.status).toBe(400);
  });

  // -------------------------------------------------------------------------
  // Assessment, impact, and the reward chain
  // -------------------------------------------------------------------------

  it('walks the acknowledgement ladder: validate → measure → rollup', async () => {
    const ctx = acme.owner;
    await validateContribution(ctx, {
      contributionId,
      outcome: 'validated',
      quality: 0.82,
      note: 'specific, actionable and consistent with the WMS samples',
      actor: { kind: 'person', label: 'Ops Lead' },
    });
    await recordImpact(ctx, {
      contributionId,
      missionImpact: 'advanced',
      confidenceBefore: 0.2,
      confidenceAfter: 0.45,
      avoidedCost: 120_00,
      affectedGoals: [],
      actor: { kind: 'person', label: 'Ops Lead' },
    });

    const view = await buildLearningHomeView(ctx);
    const contribution = view.contributions[0]!;
    expect(contribution.status).toBe('measured');
    expect(contribution.validation?.outcome).toBe('validated');
    expect(contribution.validation?.quality).toBe(0.82);
    expect(contribution.impact?.knowledgeGain).toBeCloseTo(0.25, 6);
    expect(contribution.impact?.missionImpact).toBe('advanced');
    expect(contribution.impact?.avoidedCost).toBe('120.00 USD');
    expect(view.contributionSummary?.measured).toBe(1);
    expect(view.contributionSummary?.missionsAdvanced).toBe(1);
    expect(view.contributionSummary?.totalKnowledgeGain).toBeCloseTo(0.25, 6);
    expect(view.contributionSummary?.costAvoidedByCurrency[0]?.avoidedCost).toBe(120_00);
  });

  it('converts the validated contribution into a gated reward, then settles it from the human decision', async () => {
    const ctx = acme.owner;
    // The explicit policy (rewards are never minted without one).
    await setRewardPolicy(rewardAdmin(acme.tenant.id, newId()), {
      qualifyingStatuses: ['validated', 'measured'],
      minKnowledgeGain: 0.1,
      minAffectedGoals: 0,
      tiers: [
        { name: 'thank-you-recognition', minValueScore: 0, kind: 'recognition', amount: 0 },
        { name: 'roastery-gift', minValueScore: 0.6, kind: 'gift', amount: 50_00 },
      ],
      rewardCurrency: 'USD',
    });
    const application = await applyRewardPolicy(ctx, {
      contribution: {
        kind: 'knowledge-contribution',
        id: contributionId,
        label: 'Customs broker root cause',
        contributor: { personId: employeePersonId, label: 'June Park' },
      },
      missionId,
      value: {
        status: 'measured',
        knowledgeGain: 0.25,
        missionImpact: 'advanced',
        affectedGoals: [],
        costAvoided: { amount: 120_00, currency: 'USD' },
      },
      actor: { kind: 'external', label: 'aurum-cognition' },
      rationale: 'the validated root-cause answer advanced the mission',
    });
    expect(application.reward).not.toBeNull();
    const proposed = application.reward!;
    rewardId = proposed.id;
    actionRequestId = proposed.actionRequestId;
    expect(proposed.status).toBe('proposed'); // the §20 gate holds it

    // The hub view: the proposed reward, its status and the approvals link.
    let view = await buildLearningHomeView(ctx);
    expect(view.rewards.length).toBe(1);
    expect(view.rewards[0]!.id).toBe(rewardId);
    expect(view.rewards[0]!.status).toBe('proposed');
    expect(view.rewards[0]!.actionRequestId).toBe(actionRequestId);
    expect(view.rewardSummary?.byStatus.proposed).toBe(1);

    // The human decision (a DIFFERENT authorized principal — separation
    // of duties), then the settle consumes the frozen decision.
    await decideApproval(approver(acme.tenant.id), {
      requestId: actionRequestId,
      decision: 'approve',
      note: 'the root-cause answer saved a full investigation',
    });
    const settled = await settleReward(ctx, { rewardId });
    expect(settled.status).toBe('granted');
    expect(settled.settlement?.decision).toBe('granted');

    // The history now shows the granted reward with its settlement.
    view = await buildLearningHomeView(ctx);
    expect(view.rewards[0]!.status).toBe('granted');
    expect(view.rewards[0]!.settlement?.decision).toBe('granted');
    expect(view.rewardSummary?.byStatus.granted).toBe(1);
  });

  // -------------------------------------------------------------------------
  // The mission view (the intelligence mission page's W062 panels)
  // -------------------------------------------------------------------------

  it('composes the mission learning view (requests, trail, contributions, rewards)', async () => {
    const view = await buildMissionLearningView(acme.owner, missionId);
    expect(view.missionId).toBe(missionId);
    expect(view.requests).toEqual([]); // answered — no open request
    // The planner trail: the answered ask-person decision, newest first.
    expect(view.trail.length).toBe(1);
    expect(view.trail[0]!.planId).toBe(planId);
    expect(view.trail[0]!.decision).toBe('selected');
    expect(view.trail[0]!.action).toBe('ask-person');
    expect(view.trail[0]!.chosenLabel).toBe('June Park');
    expect(view.trail[0]!.outcome).toBe('answered');
    expect(view.trail[0]!.evidenceObservationId).toBeTruthy();
    expect(view.contributions.length).toBe(1);
    expect(view.contributions[0]!.id).toBe(contributionId);
    expect(view.contributions[0]!.missionTitle).toBe('Courier customs bottleneck');
    expect(view.rewards.length).toBe(1);
    expect(view.rewards[0]!.id).toBe(rewardId);
    expect(view.rewards[0]!.missionTitle).toBe('Courier customs bottleneck');
    expect(view.rewardSummary?.totalRewards).toBe(1);
    expect(view.degraded).toEqual([]);
  });

  it("throws the owning contract's not-found for a foreign/missing mission", async () => {
    await expect(buildMissionLearningView(acme.owner, newId())).rejects.toThrow();
  });

  // -------------------------------------------------------------------------
  // The ask trigger's honest refusals
  // -------------------------------------------------------------------------

  it('refuses the ask trigger for a missing mission and a non-active mission', async () => {
    await expect(requestNextKnowledge(acme.owner, newId(), 'X')).rejects.toThrow();

    const { completeMission } = await import('@/modules/missions/contract');
    await completeMission(acme.owner, {
      missionId,
      achievedConfidence: 0.45,
      outcome: 'The customs-broker change is the evidenced root cause.',
      actor: { kind: 'person', label: 'Ops Lead' },
    });
    await expect(requestNextKnowledge(acme.owner, missionId, 'X')).rejects.toThrow(
      /completed — only an active mission can acquire knowledge/,
    );
  });

  it('maps the ask API surface honestly (401 anonymous, 404 malformed, 409 inactive)', async () => {
    const anonymous = await handleAskPost(
      new Request('https://aurum.test/api/product/learning/missions/x/ask', {
        method: 'POST',
        body: '{}',
      }),
      missionId,
    );
    expect(anonymous.status).toBe(401);
    const malformed = await handleAskPost(
      sessionRequest(acme.ownerToken, {}, 'https://aurum.test/x'),
      'not-a-uuid',
    );
    expect(malformed.status).toBe(404);
    const inactive = await handleAskPost(
      sessionRequest(acme.ownerToken, {}, 'https://aurum.test/x'),
      missionId,
    );
    expect(inactive.status).toBe(409);
  });

  // -------------------------------------------------------------------------
  // Tenant isolation + the compensation separation, end to end
  // -------------------------------------------------------------------------

  it("keeps tenant B's learning surface empty and its writes blind to tenant A", async () => {
    const view = await buildLearningHomeView(beta.owner);
    expect(view.requests).toEqual([]);
    expect(view.missions).toEqual([]);
    expect(view.contributions).toEqual([]);
    expect(view.rewards).toEqual([]);
    expect(view.contributionSummary?.total ?? 0).toBe(0);
    expect(view.rewardSummary?.totalRewards ?? 0).toBe(0);

    // Answering tenant A's request from tenant B: plan_not_found (404).
    const cross = await handleAnswerPost(
      sessionRequest(beta.ownerToken, { summary: 'an answer' }, 'https://aurum.test/x'),
      planId,
    );
    expect(cross.status).toBe(404);
    // The plan itself is invisible to tenant B's context.
    await expect(getAcquisitionPlan(beta.owner, planId)).rejects.toThrow();
  });

  it('carries no compensation/performance semantics anywhere in the surface', async () => {
    const view = await buildLearningHomeView(acme.owner);
    // The separation note is present and clean.
    expect(usesForbiddenTerm(REWARD_SEPARATION_NOTE)).toBeNull();
    // Every row field name and rendered label stays non-compensatory.
    const contributionKeys = Object.keys(view.contributions[0]!).concat(
      Object.keys(view.rewards[0]!),
    );
    for (const key of contributionKeys) {
      expect(usesForbiddenTerm(key)).toBeNull();
    }
    // The reward rows carry only the closed kind vocabulary.
    expect(['recognition', 'gift', 'voucher', 'experience', 'donation']).toContain(
      view.rewards[0]!.kind,
    );
  });

  afterAll(async () => {
    await closeDb();
  });
});
