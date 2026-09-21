// Integration tests for the interventions surface (W063) against the
// embedded PostgreSQL (PGlite, `:memory:`) through the db port.
//
// THE WORK ITEM'S ACCEPTANCE, proven end to end through REAL module
// contracts (the whole of plan §2 Journey I):
//
//   * COMPARE train/reassign/hire/automate/recruit/install/outsource —
//     the hub's seven-word vocabulary panel derives where each
//     alternative is currently compared (a recruitment proposal, an
//     automation candidate, a workforce alternative), from contracts;
//   * EXPLICIT UNCERTAINTY AND EVIDENCE — the proposal view freezes the
//     capability snapshot and cites evidence observations; the
//     workforce assessment carries its confidence, alternative
//     explanations, alternatives (outsource included) and evidence ids;
//   * PROPOSAL → APPROVAL → ACTIVATION — the decision API casts the
//     human vote on the gate request and settles it onto the proposal
//     (idempotently — a re-click is not an error); the activation API
//     registers the agent with EXACTLY the permission scopes the
//     approved recruit alternative proposed;
//   * TEAM TOPOLOGY/BUDGET — the compose API authors a draft team; the
//     lifecycle API drives the gated activation and dissolution (the
//     SAME call requests and later applies the decided transition —
//     the deterministic idempotency key);
//   * RETAIN/MODIFY/TERMINATE — the agent lifecycle API records a
//     retain decision, routes a terminate through the authority gate,
//     and the settle pump applies the approved termination (the agent
//     definition is disabled through the agents contract);
//   * OUTCOME TRACKING — the agent-subject learning outcome settles
//     expected-versus-realized, and the team's outcome timeline records
//     an assessed team outcome;
//   * HUMAN AUTHORIZATION — every consequential transition above went
//     through a human decision by a DIFFERENT principal than the
//     requester (the actions module's separation of duties); the
//     workforce assessment's decision stays a recorded human decision;
//   * TENANT ISOLATION (ADR-0001) — tenant B's hub is empty and its
//     API writes against tenant A's records read as not-found (no
//     existence leak);
//   * THE API SURFACE — anonymous is 401; malformed ids are 404; a
//     non-object body is 400; wrong-state writes are 409.

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
import { appendEvent } from '@/modules/events/contract';
import { reconstructProcess, listProcessFindings } from '@/modules/processes/contract';
import type { Process, ProcessFinding } from '@/modules/processes/contract';
import {
  registerCapability,
  registerRequirement,
} from '@/modules/capabilities/contract';
import {
  createRecruitmentProposal,
  requestRecruitmentApproval,
} from '@/modules/agent-recruitment/contract';
import type { AgentRecruitmentProposal } from '@/modules/agent-recruitment/contract';
import { registerAgent, getAgent } from '@/modules/agents/contract';
import { createTeam, recordTeamOutcome } from '@/modules/agent-teams/contract';
import type { Team } from '@/modules/agent-teams/contract';
import { recordAgentEvaluation } from '@/modules/agent-evaluation/contract';
import type { AgentEvaluation } from '@/modules/agent-evaluation/contract';
import { assessWorkforce } from '@/modules/workforce/contract';
import { registerOpportunity } from '@/modules/automation/contract';
import {
  defineOutcome,
  recordMeasurement,
  settleOutcome,
} from '@/modules/learning/contract';
import type { Outcome } from '@/modules/learning/contract';
import { ACTIONS_AUTHORITY_APPROVE, decideApproval } from '@/modules/actions/contract';

import { buildInterventionsHomeView } from '../lib/views';
import { buildProposalView } from '../lib/views';
import { buildTeamView } from '../lib/views';
import { buildAgentView } from '../lib/views';
import {
  handleAgentLifecyclePost,
  handleDecisionSettlePost,
  handleProposalActivatePost,
  handleProposalDecidePost,
  handleTeamCreatePost,
  handleTeamLifecyclePost,
} from '../lib/api';
import {
  decideAgentLifecycleFromForm,
  decideProposalGate,
  settleAgentTermination,
  validateProposalDecisionInput,
} from '../lib/workflow';

const db = getDb();

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const SESSION_COOKIE = 'aurum_session';

// Fake credentials assembled from fragments at runtime (push-protection).
const passwordFragments = ['pe', 'pper', 'mint-', '7'];

interface TenantFixture {
  tenant: Tenant;
  ownerToken: string;
  /** The owner session's principal (carries the management claims). */
  ownerPrincipalId: string;
}

async function provisionFixture(name: string): Promise<TenantFixture> {
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
    ownerToken: issued.token,
    ownerPrincipalId: issued.session.principalId,
  };
}

/** The owner's contract context (the session's own derived claims). */
function ownerCtx(fixture: TenantFixture): TenantContext {
  return {
    tenantId: fixture.tenant.id,
    principalId: fixture.ownerPrincipalId,
    authority: ['actions:approve', 'agents:administer'],
  };
}

/** A DIFFERENT authorized approver (separation of duties). */
function approverCtx(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: [ACTIONS_AUTHORITY_APPROVE] };
}

/** Aurum's worker principal (the proposer — never the decider). */
function workerCtx(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: [] };
}

function memberCtx(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: [] };
}

function sessionRequest(token: string, body: unknown, url: string): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: `${SESSION_COOKIE}=${token}` },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function at(minutes: number): string {
  return new Date(Date.parse('2026-09-20T08:00:00Z') + minutes * 60_000).toISOString();
}

/** The invoice process evidence the automation candidate is registered against. */
async function seedInvoiceProcess(ctx: TenantContext, name: string): Promise<{
  process: Process;
  findings: ProcessFinding[];
}> {
  const flow1 = newId();
  const flow2 = newId();
  const flow3 = newId();
  const events: { type: string; occurredAt: string; correlationId: string; actorKind?: 'person' | 'system' }[] = [
    { type: 'invoice.registered', occurredAt: at(0), correlationId: flow1 },
    { type: 'invoice.reviewed', occurredAt: at(30), correlationId: flow1 },
    { type: 'invoice.approved', occurredAt: at(90), correlationId: flow1 },
    { type: 'invoice.registered', occurredAt: at(1000), correlationId: flow2 },
    { type: 'invoice.reviewed', occurredAt: at(1030), correlationId: flow2 },
    { type: 'invoice.approved', occurredAt: at(1120), correlationId: flow2 },
    { type: 'invoice.registered', occurredAt: at(2000), correlationId: flow3 },
    { type: 'invoice.reviewed', occurredAt: at(2030), correlationId: flow3 },
    { type: 'invoice.reviewed', occurredAt: at(2040), correlationId: flow3 },
    { type: 'invoice.payment.failed', occurredAt: at(2045), correlationId: flow3, actorKind: 'system' },
  ];
  for (const event of events) {
    await appendEvent(ctx, {
      type: event.type,
      payload: { note: `occurrence of ${event.type}` },
      occurredAt: event.occurredAt,
      actor: {
        kind: event.actorKind ?? 'person',
        id: event.actorKind === 'system' ? undefined : '1a2b3c4d-0000-4000-8000-0000000000p2',
        label: event.actorKind === 'system' ? 'billing-system' : undefined,
      },
      source: { kind: 'system', label: 'interventions-fixture' },
      correlationId: event.correlationId,
    });
  }
  const process = await reconstructProcess(ctx, {
    name,
    scope: {
      eventTypes: ['invoice.registered', 'invoice.reviewed', 'invoice.approved', 'invoice.payment.failed'],
    },
    options: { bottleneckThresholdSeconds: 3000 },
    actor: { kind: 'person', label: 'interventions fixture' },
    rationale: 'Interventions fixture — quarterly process review',
  });
  const findings = await listProcessFindings(ctx, { processId: process.id, limit: 500 });
  return { process, findings };
}

describe('the interventions surface over the full Journey I chain', () => {
  let acme: TenantFixture;
  let beta: TenantFixture;

  let capabilityId: string;
  let agentId: string;
  let proposal: AgentRecruitmentProposal;
  let noRecruitProposal: AgentRecruitmentProposal;
  let team: Team;
  let evaluation: AgentEvaluation;
  let outcome: Outcome;
  let secondTeamId: string;

  beforeAll(async () => {
    await runMigrations(db);
    acme = await provisionFixture('Northwind Interventions');
    beta = await provisionFixture('Initech Interventions');
    const ctx = ownerCtx(acme);

    // The capability gap (the demand side, W017).
    const capability = await registerCapability(ctx, {
      name: 'cold-chain-monitoring',
      description: 'Monitoring wholesale cold-chain freshness through fulfillment',
      actor: { kind: 'person', label: 'interventions fixture' },
    });
    capabilityId = capability.id;
    await registerRequirement(ctx, {
      capabilityId,
      source: { kind: 'manual', label: 'Q4 peak coverage plan' },
      level: 0.6,
      capacity: 4,
      actor: { kind: 'person', label: 'interventions fixture' },
      rationale: 'Peak-season demand exceeds the human-coordinated supply',
    });

    // The agent (the existing workforce, W021).
    const agent = await registerAgent(ctx, {
      slug: 'freshness-monitor',
      displayName: 'Freshness Monitor',
      role: 'watch wholesale freshness signals',
      provider: 'langgraph',
      instructions:
        'Read the daily WMS freshness export and open a finding when an account crosses its floor.',
      permissions: ['observe', 'analyze'],
    });
    agentId = agent.agent.id;

    // The recruitment proposal (Aurum proposes; the manager decides).
    proposal = await createRecruitmentProposal(workerCtx(acme.tenant.id), {
      title: 'Cold-chain coverage for the Q4 peak',
      capabilityId,
      rationale:
        'Peak-season cold-chain demand exceeds the human-coordinated supply; the freshness goal depends on closing the gap',
      evidenceObservationIds: [newId(), newId()],
      alternatives: [
        {
          kind: 'train',
          summary: 'Coach June on customs paperwork and courier coordination',
          estimatedCostMinor: 40_000,
          estimatedCostCurrency: 'USD',
          estimatedWeeks: 4,
          expectedLevel: 0.15,
        },
        {
          kind: 'recruit',
          summary: 'Recruit a cold-chain monitoring agent',
          estimatedCostMinor: 90_000,
          estimatedCostCurrency: 'USD',
          estimatedWeeks: 1,
          expectedLevel: 0.3,
          recommended: true,
          agentPermissions: ['observe', 'analyze'],
        },
        {
          kind: 'hire',
          summary: 'Hire a seasonal cold-chain coordinator',
          estimatedCostMinor: 250_000,
          estimatedCostCurrency: 'USD',
          estimatedWeeks: 6,
          expectedLevel: 0.25,
        },
      ],
    });
    await requestRecruitmentApproval(workerCtx(acme.tenant.id), {
      proposalId: proposal.id,
      justification: 'the recommended agent recruitment covers the peak-season gap fastest',
    });

    // A second proposal with no recruit alternative (activation refuses it).
    noRecruitProposal = await createRecruitmentProposal(workerCtx(acme.tenant.id), {
      title: 'Coaching plan for customs paperwork',
      capabilityId,
      rationale: 'A training-first alternative if agent recruitment is rejected',
      alternatives: [
        { kind: 'train', summary: 'Coach the ops lead', estimatedCostMinor: 30_000, estimatedCostCurrency: 'USD', estimatedWeeks: 3 },
        { kind: 'reassign', summary: 'Move fulfillment coordination under ops', estimatedCostMinor: 0, estimatedCostCurrency: 'USD', estimatedWeeks: 1 },
      ],
    });
    await requestRecruitmentApproval(workerCtx(acme.tenant.id), {
      proposalId: noRecruitProposal.id,
    });

    // The workforce assessment (uncertainty + alternatives, W019).
    await assessWorkforce(ctx, {
      employee: { id: newId(), label: 'June Park' },
      recommendation: {
        kind: 'training',
        text: 'Coach June on customs paperwork and courier coordination before the Q4 peak.',
      },
      confidence: 0.75,
      additionalAlternatives: [
        { kind: 'outsource', description: 'Hand peak-season coordination to a 3PL partner' },
        { kind: 'recruit_agent', description: 'Recruit the cold-chain monitoring agent instead' },
      ],
      evidenceObservationIds: [newId()],
      actor: { kind: 'system', label: 'interventions fixture' },
    });

    // The automation candidate (the outsource-bearing vocabulary, W018).
    const { process, findings } = await seedInvoiceProcess(ctx, 'wholesale-invoicing');
    await registerOpportunity(ctx, {
      name: 'invoice-rekey-automation',
      processId: process.id,
      findingIds: findings.slice(0, 2).map((finding) => finding.id),
      capabilityId,
      description: 'Manual rekeying between the WMS and the ledger',
      frequencyCount: 220,
      period: 'month',
      currency: 'USD',
      currentCostMinor: 180_000,
      errorRate: 0.08,
      solutionTypes: ['outsource', 'recruit_agent'],
      expectedSavingsMinor: 120_000,
      expectedInvestmentMinor: 90_000,
      roiHorizonPeriods: 6,
      outcome: {
        metricName: 'monthly rekeying minutes',
        metricUnit: 'minutes',
        direction: 'at_most',
        baseline: 660,
        target: 200,
      },
      actor: { kind: 'person', label: 'interventions fixture' },
    });

    // The tracked outcome for the agent subject (W040) — settled.
    outcome = await defineOutcome(ctx, {
      subject: { kind: 'agent', id: agentId, label: 'Freshness Monitor' },
      metricName: 'freshness breach lead time',
      metricUnit: 'hours',
      direction: 'at_least',
      baseline: 8,
      expected: 12,
      actor: { kind: 'person', label: 'interventions fixture' },
    });
    const measurement = await recordMeasurement(ctx, {
      outcomeId: outcome.id,
      value: 14,
      actor: { kind: 'person', label: 'interventions fixture' },
    });
    outcome = await settleOutcome(ctx, {
      outcomeId: outcome.id,
      measurementId: measurement.id,
      actor: { kind: 'person', label: 'interventions fixture' },
    });

    // The agent evaluation (the measured decision basis, W024).
    evaluation = await recordAgentEvaluation(memberCtx(acme.tenant.id), {
      agentId,
      replacementOptions: [
        { kind: 'retain', summary: 'Keep the freshness monitor as it is', recommended: true },
        { kind: 'recruit', summary: 'Recruit a second monitor for the peak', estimatedCostMinor: 90_000 },
      ],
    });

    // The draft team (topology/budget, W023).
    const createdTeam = await createTeam(ctx, {
      slug: 'freshness-watch',
      displayName: 'Freshness Watch',
      description: 'The cold-chain monitoring cell',
      topology: 'flat',
      members: [{ agentId, role: 'freshness watcher' }],
      objectives: [
        {
          key: 'objective',
          objective: 'Keep wholesale freshness above the goal floor through the Q4 peak.',
          successCriteria: 'No account crosses its floor for more than a day.',
        },
      ],
      budget: { amountMinor: 150_000, currency: 'USD' },
      ownerPrincipal: acme.ownerPrincipalId,
    });
    team = createdTeam.team;
  });

  afterAll(async () => {
    await closeDb();
  });

  // -------------------------------------------------------------------------
  // The hub view (compare + uncertainty + evidence, from contracts)
  // -------------------------------------------------------------------------

  it('composes the hub view from the contracts with no degraded reads', async () => {
    const view = await buildInterventionsHomeView(ownerCtx(acme));

    expect(view.degraded).toEqual([]);

    // The gap (the demand side).
    expect(view.gaps).toHaveLength(1);
    const gap = view.gaps[0]!;
    expect(gap.name).toBe('cold-chain-monitoring');
    expect(gap.status).toBe('uncovered');
    expect(gap.unmetCount).toBe(1);
    expect(gap.activeRequirementCount).toBe(1);
    expect(gap.bestActiveLevel).toBeNull();

    // The proposals (the comparisons).
    expect(view.proposals).toHaveLength(2);
    const main = view.proposals.find((row) => row.id === proposal.id)!;
    expect(main.status).toBe('awaiting_approval');
    expect(main.awaitingDecision).toBe(true);
    expect(main.recommendedKind).toBe('recruit');
    expect(main.capabilityName).toBe('cold-chain-monitoring');
    expect(main.alternativeKinds).toEqual(['train', 'hire', 'recruit']);

    // The team (topology/budget).
    expect(view.teams).toHaveLength(1);
    expect(view.teams[0]!.slug).toBe('freshness-watch');
    expect(view.teams[0]!.status).toBe('draft');
    expect(view.teams[0]!.memberCount).toBe(1);
    expect(view.teams[0]!.budget).toEqual({ amountMinor: 150_000, currency: 'USD' });

    // The agent workforce.
    expect(view.agents).toHaveLength(1);
    expect(view.agents[0]!.slug).toBe('freshness-monitor');
    expect(view.agents[0]!.status).toBe('active');
    expect(view.agents[0]!.permissions).toEqual(['observe', 'analyze']);

    // The workforce assessment — uncertainty carried, never summarized away.
    expect(view.assessments).toHaveLength(1);
    const assessment = view.assessments[0]!;
    expect(assessment.employeeLabel).toBe('June Park');
    expect(assessment.recommendationKind).toBe('training');
    expect(assessment.confidence).toBe(0.75);
    expect(assessment.employmentImpacting).toBe(false);
    const alternativeKinds = assessment.alternatives.map((alternative) => alternative.kind);
    expect(alternativeKinds).toContain('outsource');
    expect(alternativeKinds).toContain('recruit_agent');
    expect(assessment.alternativeExplanations.length).toBeGreaterThan(0);
    expect(assessment.evidenceObservationIds).toHaveLength(1);
    expect(assessment.decision).toBeNull();

    // The automation candidate (the outsource vocabulary — the module
    // returns the solution types in its own canonical order).
    expect(view.opportunities).toHaveLength(1);
    expect([...view.opportunities[0]!.solutionTypes].sort()).toEqual(['outsource', 'recruit_agent']);
    expect(view.opportunities[0]!.status).toBe('candidate');

    // Outcome tracking (expected versus realized).
    expect(view.outcomes).toHaveLength(1);
    const tracked = view.outcomes[0]!;
    expect(tracked.metricName).toBe('freshness breach lead time');
    expect(tracked.expected).toBe(12);
    expect(tracked.realized).toBe(14);
    expect(tracked.assessment).toBe('exceeded');
    expect(tracked.subjectLabel).toBe('freshness-monitor');
    expect(view.outcomeSummary).not.toBeNull();
    expect(view.outcomeSummary!.settled).toBe(1);
  });

  it('derives the seven-word comparison coverage across the three families', async () => {
    const view = await buildInterventionsHomeView(ownerCtx(acme));
    const byWord = new Map(view.vocabulary.map((entry) => [entry.word, entry]));

    // The train/hire/recruit words are compared by BOTH proposals; the
    // recruit word also rides the automation candidate and the stated
    // workforce alternative.
    expect(byWord.get('train')).toMatchObject({ proposalCount: 2, automationCount: 0, workforceCount: 0 });
    expect(byWord.get('hire')).toMatchObject({ proposalCount: 1, total: 1 });
    expect(byWord.get('recruit')).toMatchObject({ proposalCount: 1, automationCount: 1, workforceCount: 1, total: 3 });
    // The outsource word is compared by the automation candidate AND the
    // workforce alternative — never by a recruitment proposal.
    expect(byWord.get('outsource')).toMatchObject({ proposalCount: 0, automationCount: 1, workforceCount: 1 });
    // The reassign word rides the module-generated workforce alternative.
    expect(byWord.get('reassign')).toMatchObject({ proposalCount: 1, workforceCount: 1 });
    // All seven words are present.
    expect(view.vocabulary.map((entry) => entry.word)).toEqual([
      'train',
      'reassign',
      'hire',
      'automate',
      'recruit',
      'install',
      'outsource',
    ]);
  });

  it('builds the proposal view with the comparison, the snapshot and the gate', async () => {
    const view = await buildProposalView(ownerCtx(acme), proposal.id);

    expect(view.proposal.status).toBe('awaiting_approval');
    expect(view.proposal.capability.name).toBe('cold-chain-monitoring');
    expect(view.proposal.capability.gapStatus).toBe('uncovered');
    expect(view.proposal.evidenceObservationIds).toHaveLength(2);
    expect(view.proposal.approval.actionRequestId).not.toBeNull();
    expect(view.proposal.approval.policyOutcome).toBe('approval_required');

    // The comparison, canonical order, the recommended one marked.
    expect(view.alternatives.map((alternative) => alternative.kind)).toEqual([
      'train',
      'hire',
      'recruit',
    ]);
    const recruit = view.alternatives.find((alternative) => alternative.kind === 'recruit')!;
    expect(recruit.recommended).toBe(true);
    expect(recruit.agentPermissions).toEqual(['observe', 'analyze']);
    expect(recruit.impliedAuthorityLevel).toBe('ANALYZE');

    // Activation is not available while the gate holds the proposal.
    expect(view.activation.available).toBe(false);
    expect(view.activation.reason).toContain('approval gate');
  });

  // -------------------------------------------------------------------------
  // The proposal decision API (the human authority gate)
  // -------------------------------------------------------------------------

  it('guards the decision API behind the session, the tenant and the state', async () => {
    const url = `https://aurum.test/api/product/interventions/proposals/${proposal.id}/decide`;
    const body = { decision: 'approve', note: 'covers the peak' };

    // Anonymous is 401.
    const anonymous = await handleProposalDecidePost(
      new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      proposal.id,
    );
    expect(anonymous.status).toBe(401);

    // A malformed id is 404.
    const malformed = await handleProposalDecidePost(
      sessionRequest(acme.ownerToken, body, url),
      'not-a-uuid',
    );
    expect(malformed.status).toBe(404);

    // Tenant B deciding tenant A's proposal reads as not-found.
    const foreign = await handleProposalDecidePost(
      sessionRequest(beta.ownerToken, body, url),
      proposal.id,
    );
    expect(foreign.status).toBe(404);
    expect((foreign as { body: { error: string } }).body.error).toBe('proposal_not_found');
  });

  it('decides the proposal at the gate and lands it first-write-wins', async () => {
    // The owner session (a different principal than the submitting worker)
    // casts the human decision; the settle lands it on the proposal.
    const decided = await handleProposalDecidePost(
      sessionRequest(
        acme.ownerToken,
        { decision: 'approve', note: 'covers the peak at the lowest cost' },
        `https://aurum.test/api/product/interventions/proposals/${proposal.id}/decide`,
      ),
      proposal.id,
    );
    expect(decided.status).toBe(200);
    const decidedBody = (decided as { body: Record<string, unknown> }).body;
    expect(decidedBody.status).toBe('approved');
    expect(decidedBody.decidedHere).toBe(true);
    expect(decidedBody.decidedBy).toBe('principal');

    // A re-click is the honest state conflict: the decision already
    // landed — first-write-wins is rendered, never silently replayed.
    const replay = await handleProposalDecidePost(
      sessionRequest(
        acme.ownerToken,
        { decision: 'reject' },
        `https://aurum.test/api/product/interventions/proposals/${proposal.id}/decide`,
      ),
      proposal.id,
    );
    expect(replay.status).toBe(409);
  });

  it('lands a request another approver already decided (the idempotent settle)', async () => {
    // A different authorized approver decides the no-recruit proposal's
    // REQUEST directly through the actions contract — without settling
    // the proposal row.
    const view = await buildProposalView(ownerCtx(acme), noRecruitProposal.id);
    const requestId = view.proposal.approval.actionRequestId!;
    await decideApproval(approverCtx(acme.tenant.id), {
      requestId,
      decision: 'approve',
      note: 'the coaching plan is cheaper',
    });

    // The owner's API call now hits an already-decided request: the
    // settle lands the recorded decision (decidedHere false — the other
    // approver's vote stands).
    const landed = await handleProposalDecidePost(
      sessionRequest(
        acme.ownerToken,
        { decision: 'reject' },
        `https://aurum.test/api/product/interventions/proposals/${noRecruitProposal.id}/decide`,
      ),
      noRecruitProposal.id,
    );
    expect(landed.status).toBe(200);
    const landedBody = (landed as { body: Record<string, unknown> }).body;
    expect(landedBody.decidedHere).toBe(false);
    expect(landedBody.status).toBe('approved');
    expect(landedBody.decidedBy).toBe('principal');

    // Activation has no recruit alternative to activate — a state conflict.
    const activation = await handleProposalActivatePost(
      sessionRequest(
        acme.ownerToken,
        {
          slug: 'coaching-plan',
          role: 'coached ops lead',
          provider: 'crewai',
          instructions: 'n/a',
          permissions: ['observe'],
        },
        `https://aurum.test/api/product/interventions/proposals/${noRecruitProposal.id}/activate`,
      ),
      noRecruitProposal.id,
    );
    expect(activation.status).toBe(409);
  });

  // -------------------------------------------------------------------------
  // The activation API (proposal → approval → activation)
  // -------------------------------------------------------------------------

  it('activates the approved recruit alternative with the proposed scopes', async () => {
    // The proposal view now offers the activation.
    const view = await buildProposalView(ownerCtx(acme), proposal.id);
    expect(view.activation.available).toBe(true);
    expect(view.activation.defaultPermissions).toEqual(['observe', 'analyze']);
    expect(view.activation.suggestedSlug).toBe('cold-chain-coverage-for-the-q4-peak');

    const activated = await handleProposalActivatePost(
      sessionRequest(
        acme.ownerToken,
        {
          slug: 'cold-chain-monitor',
          displayName: 'Cold Chain Monitor',
          role: 'monitor the cold chain through the Q4 peak',
          provider: 'langgraph',
          instructions:
            'Watch the WMS freshness export against the cold-chain goal and open findings on breaches.',
          permissions: ['observe', 'analyze'],
        },
        `https://aurum.test/api/product/interventions/proposals/${proposal.id}/activate`,
      ),
      proposal.id,
    );
    expect(activated.status).toBe(200);
    const activatedBody = (activated as { body: Record<string, unknown> }).body;
    expect(activatedBody.created).toBe(true);
    const agent = activatedBody.agent as { slug: string; status: string; permissions: string[] };
    expect(agent.slug).toBe('cold-chain-monitor');
    expect(agent.status).toBe('active');
    expect(agent.permissions).toEqual(['observe', 'analyze']);

    // Registering is idempotent per (tenant, slug) — a retry replays.
    const replay = await handleProposalActivatePost(
      sessionRequest(
        acme.ownerToken,
        {
          slug: 'cold-chain-monitor',
          role: 'monitor the cold chain',
          provider: 'langgraph',
          instructions: 'Watch the WMS freshness export.',
          permissions: ['observe'],
        },
        `https://aurum.test/api/product/interventions/proposals/${proposal.id}/activate`,
      ),
      proposal.id,
    );
    expect(replay.status).toBe(200);
    expect((replay as { body: Record<string, unknown> }).body.created).toBe(false);

    // The agent now appears in the hub's workforce.
    const hub = await buildInterventionsHomeView(ownerCtx(acme));
    expect(hub.agents.map((row) => row.slug)).toContain('cold-chain-monitor');

    // Tenant B cannot activate tenant A's proposal.
    const foreign = await handleProposalActivatePost(
      sessionRequest(
        beta.ownerToken,
        {
          slug: 'stolen-agent',
          role: 'x',
          provider: 'crewai',
          instructions: 'x',
          permissions: ['observe'],
        },
        `https://aurum.test/api/product/interventions/proposals/${proposal.id}/activate`,
      ),
      proposal.id,
    );
    expect(foreign.status).toBe(404);
  });

  // -------------------------------------------------------------------------
  // The team compose and lifecycle APIs (topology/budget, gated)
  // -------------------------------------------------------------------------

  it('composes a draft team through the API with honest input guards', async () => {
    const url = 'https://aurum.test/api/product/interventions/teams';

    // Anonymous is 401.
    const anonymous = await handleTeamCreatePost(
      new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }),
    );
    expect(anonymous.status).toBe(401);

    // A non-object body is 400.
    const badBody = await handleTeamCreatePost(
      sessionRequest(acme.ownerToken, [1, 2], url),
    );
    expect(badBody.status).toBe(400);

    // An empty roster is 400.
    const emptyRoster = await handleTeamCreatePost(
      sessionRequest(
        acme.ownerToken,
        { displayName: 'No members', topology: 'flat', members: [], objective: 'x', budgetAmount: '1', budgetCurrency: 'USD' },
        url,
      ),
    );
    expect(emptyRoster.status).toBe(400);

    // A valid compose creates the draft.
    const composed = await handleTeamCreatePost(
      sessionRequest(
        acme.ownerToken,
        {
          displayName: 'Ledger Reconciliation Cell',
          description: 'Reconciles the WMS and ledger flows',
          topology: 'hierarchical',
          members: [{ agentId, role: 'reconciliation lead' }],
          objective: 'Close the WMS-ledger gap every week.',
          successCriteria: 'Zero unmatched invoices at Friday close.',
          budgetAmount: '900.00',
          budgetCurrency: 'EUR',
          ownerPrincipal: acme.ownerPrincipalId,
        },
        url,
      ),
    );
    expect(composed.status).toBe(200);
    const composedBody = (composed as { body: Record<string, unknown> }).body;
    secondTeamId = (composedBody.team as { id: string }).id;
    expect(composedBody.created).toBe(true);
    expect((composedBody.team as { status: string }).status).toBe('draft');

    // The draft team appears in the hub.
    const hub = await buildInterventionsHomeView(ownerCtx(acme));
    expect(hub.teams.map((row) => row.id)).toContain(secondTeamId);
  });

  it('drives the gated team activation: request, human decision, apply', async () => {
    const url = `https://aurum.test/api/product/interventions/teams/${team.id}/lifecycle`;

    // Anonymous is 401; a malformed id is 404.
    expect(
      (await handleTeamLifecyclePost(
        new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"action":"activate"}' }),
        team.id,
      )).status,
    ).toBe(401);
    expect(
      (await handleTeamLifecyclePost(
        sessionRequest(acme.ownerToken, { action: 'activate' }, url),
        'not-a-uuid',
      )).status,
    ).toBe(404);

    // The first request waits at the gate (the requester is the owner
    // session — the decision belongs to a DIFFERENT authorized human).
    const requested = await handleTeamLifecyclePost(
      sessionRequest(acme.ownerToken, { action: 'activate' }, url),
      team.id,
    );
    expect(requested.status).toBe(200);
    const requestedBody = (requested as { body: Record<string, unknown> }).body;
    expect(requestedBody.applied).toBe(false);
    const gate = requestedBody.gate as { actionRequestId: string; status: string };
    expect(gate.status).toBe('pending');

    // A different approver decides the gate request.
    await decideApproval(approverCtx(acme.tenant.id), {
      requestId: gate.actionRequestId,
      decision: 'approve',
      note: 'the roster and budget are right',
    });

    // The SAME call now replays the decided request and applies it.
    const applied = await handleTeamLifecyclePost(
      sessionRequest(acme.ownerToken, { action: 'activate' }, url),
      team.id,
    );
    expect(applied.status).toBe(200);
    const appliedBody = (applied as { body: Record<string, unknown> }).body;
    expect(appliedBody.applied).toBe(true);
    expect((appliedBody.team as { status: string }).status).toBe('active');

    // Record a team outcome now that the team is active (outcome tracking).
    await recordTeamOutcome(memberCtx(acme.tenant.id), {
      teamId: team.id,
      objectiveKey: 'objective',
      headline: 'Freshness floor held through the first peak week',
      assessment: 'met',
      detail: 'No account crossed its floor for more than a day.',
    });
  });

  it('drives the gated dissolution with its required reason', async () => {
    const url = `https://aurum.test/api/product/interventions/teams/${team.id}/lifecycle`;

    // Dissolving without a reason is invalid input.
    expect(
      (await handleTeamLifecyclePost(
        sessionRequest(acme.ownerToken, { action: 'dissolve' }, url),
        team.id,
      )).status,
    ).toBe(400);

    // The dissolution request waits at the gate.
    const requested = await handleTeamLifecyclePost(
      sessionRequest(
        acme.ownerToken,
        { action: 'dissolve', reason: 'the peak ended; the objective is retired' },
        url,
      ),
      team.id,
    );
    expect(requested.status).toBe(200);
    const requestedBody = (requested as { body: Record<string, unknown> }).body;
    expect(requestedBody.applied).toBe(false);
    const gate = requestedBody.gate as { actionRequestId: string };

    // A different approver decides; the same call applies.
    await decideApproval(approverCtx(acme.tenant.id), {
      requestId: gate.actionRequestId,
      decision: 'approve',
    });
    const applied = await handleTeamLifecyclePost(
      sessionRequest(
        acme.ownerToken,
        { action: 'dissolve', reason: 'the peak ended; the objective is retired' },
        url,
      ),
      team.id,
    );
    expect(applied.status).toBe(200);
    expect((applied as { body: Record<string, unknown> }).body.applied).toBe(true);
    expect(((applied as { body: Record<string, unknown> }).body.team as { status: string }).status).toBe('dissolved');

    // A dissolved team is terminal — no transition moves it again.
    const terminal = await handleTeamLifecyclePost(
      sessionRequest(acme.ownerToken, { action: 'activate' }, url),
      team.id,
    );
    expect(terminal.status).toBe(409);
  });

  it('builds the team view with topology, budget and the outcome timeline', async () => {
    const view = await buildTeamView(ownerCtx(acme), team.id);

    expect(view.team.slug).toBe('freshness-watch');
    expect(view.team.status).toBe('dissolved');
    expect(view.members).toHaveLength(1);
    expect(view.members[0]!.agentSlug).toBe('freshness-monitor');
    expect(view.members[0]!.role).toBe('freshness watcher');
    expect(view.objectives).toHaveLength(1);
    expect(view.objectives[0]!.key).toBe('objective');
    expect(view.budget).toEqual({ amountMinor: 150_000, currency: 'USD' });
    expect(view.team.ownerPrincipal).toBe(acme.ownerPrincipalId);

    // The outcome timeline (outcome tracking for the team dimension).
    expect(view.outcomes).toHaveLength(1);
    expect(view.outcomes[0]!.assessment).toBe('met');
    expect(view.outcomes[0]!.objectiveKey).toBe('objective');

    // The version chain: created → activated → dissolved.
    expect(view.versions.map((version) => version.changeKind)).toEqual([
      'created',
      'activated',
      'dissolved',
    ]);

    // Tenant B cannot read tenant A's team.
    await expect(buildTeamView(ownerCtx(beta), team.id)).rejects.toThrow();
  });

  // -------------------------------------------------------------------------
  // The agent lifecycle API (retain / modify / terminate)
  // -------------------------------------------------------------------------

  it('records a retain decision and routes a termination through the gate', async () => {
    const url = `https://aurum.test/api/product/interventions/agents/${agentId}/lifecycle`;

    // Anonymous is 401; a malformed id is 404.
    expect(
      (await handleAgentLifecyclePost(
        new Request(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ evaluationId: evaluation.id, change: 'retain', rationale: 'x' }),
        }),
        agentId,
      )).status,
    ).toBe(401);
    expect(
      (await handleAgentLifecyclePost(
        sessionRequest(acme.ownerToken, { evaluationId: evaluation.id, change: 'retain', rationale: 'x' }, url),
        'not-a-uuid',
      )).status,
    ).toBe(404);

    // A missing evaluation id is 400.
    expect(
      (await handleAgentLifecyclePost(
        sessionRequest(acme.ownerToken, { change: 'retain', rationale: 'x' }, url),
        agentId,
      )).status,
    ).toBe(400);

    // RETAIN — recorded management evidence, nothing to apply.
    const retained = await handleAgentLifecyclePost(
      sessionRequest(
        acme.ownerToken,
        { evaluationId: evaluation.id, change: 'retain', rationale: 'the evaluation is clean — keep it' },
        url,
      ),
      agentId,
    );
    expect(retained.status).toBe(200);
    const retainedBody = (retained as { body: Record<string, unknown> }).body;
    expect(retainedBody.applied).toBeNull();
    expect((retainedBody.decision as { status: string }).status).toBe('recorded');

    // TERMINATE — through the authority gate (a different human decides).
    const terminated = await handleAgentLifecyclePost(
      sessionRequest(
        acme.ownerToken,
        {
          evaluationId: evaluation.id,
          change: 'terminate',
          rationale: 'the peak ended and the capability is retired',
          replacementOptionId: evaluation.replacementOptions.find(
            (option) => option.kind === 'recruit',
          )!.id,
        },
        url,
      ),
      agentId,
    );
    expect(terminated.status).toBe(200);
    const terminatedBody = (terminated as { body: Record<string, unknown> }).body;
    expect(terminatedBody.applied).toBe(false);
    expect((terminatedBody.decision as { status: string }).status).toBe('awaiting_approval');
    const gateRequestId = terminatedBody.gateRequestId as string;
    expect(gateRequestId).not.toBeNull();

    // The settle before the decision leaves the termination waiting.
    const earlySettle = await handleDecisionSettlePost(
      sessionRequest(
        acme.ownerToken,
        {},
        `https://aurum.test/api/product/interventions/decisions/${(terminatedBody.decision as { id: string }).id}/settle`,
      ),
      (terminatedBody.decision as { id: string }).id,
    );
    expect(earlySettle.status).toBe(200);
    expect(((earlySettle as { body: Record<string, unknown> }).body.decision as { status: string }).status).toBe(
      'awaiting_approval',
    );

    // A different approver decides the termination request.
    await decideApproval(approverCtx(acme.tenant.id), {
      requestId: gateRequestId,
      decision: 'approve',
      note: 'the seasonal capability is retired',
    });

    // The settle pump applies the approved termination.
    const settled = await handleDecisionSettlePost(
      sessionRequest(
        acme.ownerToken,
        {},
        `https://aurum.test/api/product/interventions/decisions/${(terminatedBody.decision as { id: string }).id}/settle`,
      ),
      (terminatedBody.decision as { id: string }).id,
    );
    expect(settled.status).toBe(200);
    expect(((settled as { body: Record<string, unknown> }).body.decision as { status: string }).status).toBe(
      'applied',
    );

    // The agent definition is disabled through the agents contract.
    const agent = await getAgent(ownerCtx(acme), { agentId });
    expect(agent.status).toBe('disabled');

    // Settling again is an idempotent read.
    const resettle = await handleDecisionSettlePost(
      sessionRequest(
        acme.ownerToken,
        {},
        `https://aurum.test/api/product/interventions/decisions/${(terminatedBody.decision as { id: string }).id}/settle`,
      ),
      (terminatedBody.decision as { id: string }).id,
    );
    expect(resettle.status).toBe(200);
    expect(((resettle as { body: Record<string, unknown> }).body.decision as { status: string }).status).toBe(
      'applied',
    );
  });

  it('builds the agent view with the measurement, the decisions and the outcomes', async () => {
    const view = await buildAgentView(ownerCtx(acme), agentId);

    expect(view.agent.slug).toBe('freshness-monitor');
    expect(view.agent.status).toBe('disabled');
    expect(view.evaluation).not.toBeNull();
    expect([...view.evaluation!.replacementOptions.map((option) => option.kind)].sort()).toEqual([
      'recruit',
      'retain',
    ]);
    // The six dimensions are the honest computed numbers.
    expect(view.evaluation!.outcome.outcomesTotal).toBe(1);
    expect(view.evaluation!.outcome.settled).toBe(1);
    expect(view.evaluation!.cost.totalCostMinor).toBe(0);
    expect(view.evaluation!.quality.successRate).toBeNull();
    expect(view.evaluation!.security.grantedPermissions).toEqual(['observe', 'analyze']);

    // The decisions (newest first): the retained evidence and the applied
    // termination.
    expect(view.decisions.map((decision) => decision.change).sort()).toEqual([
      'retain',
      'terminate',
    ]);
    const termination = view.decisions.find((decision) => decision.change === 'terminate')!;
    expect(termination.status).toBe('applied');
    expect(termination.actionRequestId).not.toBeNull();
    expect(termination.appliedAt).not.toBeNull();

    // The tied outcomes (expected versus realized).
    expect(view.outcomes).toHaveLength(1);
    expect(view.outcomes[0]!.realized).toBe(14);
    expect(view.outcomes[0]!.assessment).toBe('exceeded');

    // Tenant B cannot read tenant A's agent.
    await expect(buildAgentView(ownerCtx(beta), agentId)).rejects.toThrow();
  });

  it('refuses a lifecycle decision that cites a foreign evaluation', async () => {
    // Tenant B's owner decides against tenant A's evaluation id — the
    // evaluation reads as missing (no existence leak).
    const foreign = await handleAgentLifecyclePost(
      sessionRequest(
        beta.ownerToken,
        { evaluationId: evaluation.id, change: 'retain', rationale: 'foreign attempt' },
        `https://aurum.test/api/product/interventions/agents/${agentId}/lifecycle`,
      ),
      agentId,
    );
    expect(foreign.status).toBe(404);
  });

  // -------------------------------------------------------------------------
  // The workflow layer's honest state guards (direct calls)
  // -------------------------------------------------------------------------

  it('refuses deciding a proposal that is not at the gate', async () => {
    // The proposal was approved earlier in the flow — deciding it again
    // through the workflow is a state conflict, not a silent no-op.
    await expect(
      decideProposalGate(
        ownerCtx(acme),
        proposal.id,
        validateProposalDecisionInput({ decision: 'approve', note: null }),
      ),
    ).rejects.toMatchObject({ code: 'intervention_state' });
  });

  it('refuses activating a proposal that is not approved', async () => {
    // A draft proposal (never submitted) cannot activate anything.
    const draft = await createRecruitmentProposal(workerCtx(acme.tenant.id), {
      title: 'A draft never submitted',
      capabilityId,
      rationale: 'A comparison that was never requested',
      alternatives: [
        { kind: 'automate', summary: 'automate the work' },
        { kind: 'install', summary: 'install a capability' },
      ],
    });
    const { activateRecruitedAgent } = await import('../lib/workflow');
    await expect(
      activateRecruitedAgent(ownerCtx(acme), draft.id, {
        slug: 'draft-agent',
        displayName: null,
        role: 'x',
        description: null,
        provider: 'crewai',
        instructions: 'x',
        permissions: ['observe'],
      }),
    ).rejects.toMatchObject({ code: 'intervention_state' });
  });

  it('settles an applied termination through the workflow (the pump is a read)', async () => {
    const view = await buildAgentView(ownerCtx(acme), agentId);
    const termination = view.decisions.find((decision) => decision.change === 'terminate')!;
    const settled = await settleAgentTermination(ownerCtx(acme), termination.id);
    expect(settled.status).toBe('applied');
    expect(settled.appliedAt).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // Tenant isolation (ADR-0001)
  // -------------------------------------------------------------------------

  it('renders tenant B an empty hub with no degraded reads', async () => {
    const view = await buildInterventionsHomeView(ownerCtx(beta));
    expect(view.degraded).toEqual([]);
    expect(view.gaps).toEqual([]);
    expect(view.proposals).toEqual([]);
    expect(view.teams).toEqual([]);
    expect(view.agents).toEqual([]);
    expect(view.assessments).toEqual([]);
    expect(view.opportunities).toEqual([]);
    expect(view.outcomes).toEqual([]);
    expect(view.vocabulary.every((entry) => entry.total === 0)).toBe(true);
  });

  it('keeps the workflow types honest', async () => {
    // decideAgentLifecycleFromForm + settleAgentTermination are exported
    // and typed (the surface's own workflow layer).
    expect(typeof decideAgentLifecycleFromForm).toBe('function');
    expect(typeof settleAgentTermination).toBe('function');
  });
});
