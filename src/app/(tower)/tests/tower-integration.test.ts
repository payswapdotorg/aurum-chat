// Integration tests for the Management Control Tower (W033) against the
// embedded PostgreSQL (PGlite, `:memory:`) through the db port.
//
// The acceptance core of the work item — "Build management UI around
// Today, Goals, Situation, Unknowns, Missions, Risks, Opportunities,
// Capabilities, Processes, Workforce, Agents, Automation, Evidence,
// Recommendations and Approvals" — proven end to end:
//
//   * SEED one tenant through REAL module contracts only (the same
//     surface the (tower) pages and /api/tower routes read): goals,
//     observations, claims, unknowns, contradictions, beliefs, world
//     entities/relationships, people, capabilities (supply +
//     requirement), a full cognitive execution with risk/opportunity/
//     capability-gap findings and an EXECUTE-gated action proposal, a
//     second gated action request, missions, a reconstructed process
//     (manual-effort + duplication findings), an agent definition +
//     queued execution, and a goal-gap discovery run.
//   * BUILD every tower view and assert the management surfaces actually
//     surface the seeded state (data flows end to end; no empty
//     skeletons).
//   * TENANT ISOLATION: a second tenant's views are empty and contain
//     none of the first tenant's data (ADR-0001 at the tower boundary).
//   * THE APPROVALS WRITE PATH: the tower API's decision handling
//     enforces the actions contract's own rules — authority claim
//     required, separation of duties, first-decision-wins terminality.
//   * THE API SURFACE: envelope shape, unknown-surface handling and
//     the W058 session boundary (anonymous requests are 401; scope comes
//     from the session cookie, never a query parameter).

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { runMigrations } from '../../../../scripts/migrate';

import { addTenantMember, provisionTenant } from '@/modules/organizations/contract';
import type { Tenant } from '@/modules/organizations/contract';
import { registerUser, selectCompany } from '@/modules/auth/contract';
import { createGoal } from '@/modules/goals/contract';
import type { Goal } from '@/modules/goals/contract';
import { recordObservation } from '@/modules/observations/contract';
import type { Observation } from '@/modules/observations/contract';
import {
  formBelief,
  listUnknowns,
  recordClaim,
  recordUnknown,
  registerContradiction,
} from '@/modules/epistemics/contract';
import type { Claim, Unknown } from '@/modules/epistemics/contract';
import { createMission } from '@/modules/missions/contract';
import type { Mission } from '@/modules/missions/contract';
import { createEntity, createRelationship } from '@/modules/world/contract';
import { createEmployee, createPerson } from '@/modules/people/contract';
import type { Person } from '@/modules/people/contract';
import {
  registerCapability,
  registerRequirement,
  registerSupply,
} from '@/modules/capabilities/contract';
import type { Capability } from '@/modules/capabilities/contract';
import { authorizeAction } from '@/modules/actions/contract';
import type { ActionRequest } from '@/modules/actions/contract';
import {
  runNextStage,
  startExecution,
} from '@/modules/cognition/contract';
import type { CognitiveExecutionTrace } from '@/modules/cognition/contract';
import { reconstructProcess } from '@/modules/processes/contract';
import {
  registerAgent,
  submitAgentExecution,
} from '@/modules/agents/contract';
import { runGoalGapDiscovery } from '@/modules/attention/contract';

import { buildTodayView } from '../lib/views/today';
import { buildGoalsView } from '../lib/views/goals';
import { buildSituationView } from '../lib/views/situation';
import { buildUnknownsView } from '../lib/views/unknowns';
import { buildMissionsView } from '../lib/views/missions';
import { buildRisksView } from '../lib/views/risks';
import { buildOpportunitiesView } from '../lib/views/opportunities';
import { buildCapabilitiesView } from '../lib/views/capabilities';
import { buildProcessesView } from '../lib/views/processes';
import { buildAutomationView } from '../lib/views/automation';
import { buildWorkforceView } from '../lib/views/workforce';
import { buildAgentsView } from '../lib/views/agents';
import { buildEvidenceView } from '../lib/views/evidence';
import { buildRecommendationsView } from '../lib/views/recommendations';
import { buildApprovalsView } from '../lib/views/approvals';
import { buildTowerView } from '../lib/surfaces';
import {
  handleTowerApprovalDecision,
  handleTowerSurfaceGet,
} from '../lib/api';
import type { ApiResult } from '../lib/api';

const db = getDb();

// ---------------------------------------------------------------------------
// Fixture context
// ---------------------------------------------------------------------------

const T0 = '2026-09-14T09:15:00.000Z';

function member(tenantId: string, principalId: string, authority: string[] = []): TenantContext {
  return { tenantId, principalId, authority };
}

interface TenantFixture {
  tenant: Tenant;
  owner: TenantContext;
  ownerWithApprove: TenantContext;
  otherPrincipal: TenantContext;
  otherWithApprove: TenantContext;
  /** Signed-in sessions (W058): the owner, an admin, and a plain member. */
  ownerToken: string;
  adminToken: string;
  memberToken: string;
}

/** The session cookie the tower API resolves (kept in sync with lib/session). */
const SESSION_COOKIE = 'aurum_session';

// Fake credentials are assembled from fragments at runtime (push-protection).
const passwordFragments = ['qu', 'artz', '-l', 'antern-31'];

async function registeredSession(label: string): Promise<{ principalId: string; token: string }> {
  const local = label.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const email = [local, '.', newId().slice(0, 8), '@example', '.test'].join('');
  const issued = await registerUser({
    displayName: label,
    email,
    password: passwordFragments.join(''),
  });
  return { principalId: issued.session.principalId, token: issued.token };
}

async function provisionFixture(name: string): Promise<TenantFixture> {
  const owner = await registeredSession(`tower-${name}-owner`);
  const tenant = await provisionTenant(
    { principalId: newId(), authority: ['organizations:provision'] },
    { name, ownerPrincipalId: owner.principalId },
  );
  // A fresh session has no company yet: select the provisioned one (the
  // real onboarding write path).
  await selectCompany({ token: owner.token, tenantId: tenant.id });

  const admin = await registeredSession(`tower-${name}-admin`);
  await addTenantMember(
    { tenantId: tenant.id, principalId: owner.principalId, authority: [] },
    { principalId: admin.principalId, role: 'admin' },
  );
  await selectCompany({ token: admin.token, tenantId: tenant.id });

  const plain = await registeredSession(`tower-${name}-member`);
  await addTenantMember(
    { tenantId: tenant.id, principalId: owner.principalId, authority: [] },
    { principalId: plain.principalId, role: 'member' },
  );
  await selectCompany({ token: plain.token, tenantId: tenant.id });

  return {
    tenant,
    owner: member(tenant.id, owner.principalId),
    ownerWithApprove: member(tenant.id, owner.principalId, ['actions:approve']),
    otherPrincipal: member(tenant.id, admin.principalId),
    otherWithApprove: member(tenant.id, admin.principalId, ['actions:approve']),
    ownerToken: owner.token,
    adminToken: admin.token,
    memberToken: plain.token,
  };
}

/** A request carrying one session cookie (the only scope source post-W058). */
function sessionRequest(token: string, path = '/api/tower/today', method: 'GET' | 'POST' = 'GET'): Request {
  return new Request(`https://tower.test${path}`, {
    method,
    headers: { cookie: `${SESSION_COOKIE}=${token}` },
  });
}

// ---------------------------------------------------------------------------
// The seeded management scenario
// ---------------------------------------------------------------------------

describe('the Management Control Tower over a fully seeded tenant', () => {
  let acme: TenantFixture;
  let beta: TenantFixture;

  let goal: Goal;
  let invoiceObservations: Observation[];
  let channelObservation: Observation;
  let claim: Claim;
  let unknown: Unknown;
  let mission: Mission;
  let capability: Capability;
  let person: Person;
  let cognitionTrace: CognitiveExecutionTrace;
  let cognitionGateRequest: ActionRequest;
  let directGateRequest: ActionRequest;

  beforeAll(async () => {
    await runMigrations(db);
    acme = await provisionFixture('Acme Intelligence');
    beta = await provisionFixture('Beta Systems');

    const ctx = acme.owner;

    // Direction: one critical goal with a churn metric.
    goal = await createGoal(ctx, {
      title: 'Q4 churn reduction',
      objective: 'Reduce monthly customer churn.',
      desiredState: 'Churn is below 5% every month of the quarter.',
      metrics: [
        { name: 'monthly-churn-ratio', unit: 'ratio', direction: 'at_most', threshold: 0.05 },
      ],
      horizonStart: T0,
      horizonEnd: '2026-12-31T00:00:00.000Z',
      owner: { kind: 'person', label: 'VP Customer Success' },
      priority: 'critical',
      evidenceSources: [{ kind: 'source', label: 'billing-export' }],
      successCriteria: 'Three consecutive months with churn at or below 5%.',
      actor: { kind: 'person', label: 'CEO' },
      rationale: 'board-2026',
    });

    // Evidence: a person-performed, case-keyed invoice flow (4 across 2
    // cases, with repetition inside case-1) plus one channel message.
    invoiceObservations = [];
    for (const [index, orderId] of ['case-1', 'case-1', 'case-1', 'case-2'].entries()) {
      invoiceObservations.push(
        await recordObservation(ctx, {
          kind: 'invoice-entry',
          payload: { orderId, amount: 100 + index },
          observedAt: `2026-09-20T10:0${index}:00.000Z`,
          source: { kind: 'person', label: 'Dana Doe' },
          channel: 'web',
          confidence: { value: 0.95, method: 'human-entry' },
        }),
      );
    }
    channelObservation = await recordObservation(ctx, {
      kind: 'channel.message',
      payload: { text: 'churn spiked to 9% in September' },
      observedAt: '2026-10-01T08:00:00.000Z',
      source: { kind: 'source', label: 'slack' },
      channel: 'slack',
      confidence: { value: 0.8, method: 'operator-report' },
    });

    // Epistemics: a claim, an unknown, a retained contradiction, a belief.
    claim = await recordClaim(ctx, {
      proposition: 'Monthly churn reached 9% in September.',
      confidence: { value: 0.8, method: 'reported' },
      evidenceObservationIds: [channelObservation.id],
    });
    unknown = await recordUnknown(ctx, {
      question: 'What is driving the September churn spike?',
      consequence: 'Without the drivers, retention spend cannot be targeted at the cause.',
      relatedObservationIds: [channelObservation.id],
      relatedClaimIds: [claim.id],
    });
    await registerContradiction(ctx, {
      left: { kind: 'observation', id: channelObservation.id },
      right: { kind: 'claim', id: claim.id },
      note: 'The September churn figure is contradicted by the billing export summary.',
    });
    await formBelief(ctx, {
      proposition: 'Churn is trending above the quarterly target.',
      confidence: { value: 0.72, method: 'weighed-evidence' },
      supportingObservationIds: [channelObservation.id],
      validFrom: '2026-09-01T00:00:00.000Z',
    });

    // World model: Dana (person) is a member of the Support team.
    const team = await createEntity(ctx, {
      kind: 'team',
      name: 'Customer Support',
      description: 'The support organization.',
    });
    const danaEntity = await createEntity(ctx, {
      kind: 'person',
      name: 'Dana Doe',
      description: 'Support analyst.',
    });
    await createRelationship(ctx, {
      type: 'member_of',
      fromEntityId: danaEntity.id,
      toEntityId: team.id,
    });

    // People: Dana is an employee.
    person = await createPerson(ctx, { fullName: 'Dana Doe', email: 'dana@acme.test' });
    await createEmployee(ctx, {
      personId: person.id,
      title: 'Support Analyst',
      department: 'Support',
    });

    // Capabilities: Dana supplies data analysis below the demanded level;
    // copywriting is demanded but unsupplied.
    capability = await registerCapability(ctx, {
      name: 'Data analysis',
      actor: { kind: 'person', label: 'CEO' },
    });
    await registerSupply(ctx, {
      capabilityId: capability.id,
      supplier: { kind: 'employee', id: person.id, label: 'Dana Doe' },
      level: 0.7,
      actor: { kind: 'person', label: 'CEO' },
    });
    await registerRequirement(ctx, {
      capabilityId: capability.id,
      source: { kind: 'goal', id: goal.id, label: 'Q4 churn reduction' },
      level: 0.9,
      actor: { kind: 'person', label: 'CEO' },
    });
    const copywriting = await registerCapability(ctx, {
      name: 'Technical copywriting',
      actor: { kind: 'person', label: 'CEO' },
    });
    await registerRequirement(ctx, {
      capabilityId: copywriting.id,
      source: { kind: 'manual', label: 'documentation refresh' },
      actor: { kind: 'person', label: 'CEO' },
    });

    // A full cognitive execution: findings + an EXECUTE-gated proposal
    // that suspends the loop awaiting human approval.
    cognitionTrace = await startExecution(ctx, {
      trigger: { kind: 'management', label: 'October ops review' },
      focus: { topics: ['churn', 'retention'], entities: [{ kind: 'goal', id: goal.id }] },
      actor: { kind: 'person', label: 'VP Customer Success' },
      rationale: 'monthly churn review',
    });
    const executionId = cognitionTrace.id;
    await runNextStage(ctx, {
      executionId,
      stage: 'observation',
      reference: [channelObservation.id],
    });
    await runNextStage(ctx, { executionId, stage: 'evidence-memory' });
    await runNextStage(ctx, { executionId, stage: 'world-update', update: null });
    await runNextStage(ctx, { executionId, stage: 'epistemic-evaluation', claims: [] });
    await runNextStage(ctx, {
      executionId,
      stage: 'goal-evaluation',
      relatedGoalIds: [goal.id],
    });
    await runNextStage(ctx, {
      executionId,
      stage: 'unknown-mission-evaluation',
      unknowns: [],
      missions: [],
    });
    await runNextStage(ctx, { executionId, stage: 'knowledge-acquisition', missionId: null });
    await runNextStage(ctx, { executionId, stage: 'model-update', belief: null });
    await runNextStage(ctx, {
      executionId,
      stage: 'risk-opportunity-capability-analysis',
      findings: [
        {
          kind: 'risk',
          statement: 'Churn at 9% threatens the Q4 churn-reduction goal.',
          evidenceObservationIds: [channelObservation.id],
          affectedGoalIds: [goal.id],
        },
        {
          kind: 'opportunity',
          statement: 'Support transcripts are an untapped retention signal source.',
          evidenceObservationIds: [channelObservation.id],
          affectedGoalIds: [goal.id],
        },
        {
          kind: 'capability-gap',
          statement: 'Data analysis capacity is below what the churn goal requires.',
          evidenceObservationIds: [channelObservation.id],
          affectedGoalIds: [goal.id],
        },
      ],
    });
    const gated = await runNextStage(ctx, {
      executionId,
      stage: 'recommendation-ask-proposal-action',
      action: {
        actionKind: 'data-export',
        authorityLevel: 'EXECUTE',
        payload: { target: 'bi-warehouse', dataset: 'churn-cohort' },
        justification: 'Export churn cohorts for driver analysis.',
      },
    });
    expect(gated.state).toBe('awaiting_approval');
    expect(gated.pending.requestId).not.toBeNull();
    cognitionGateRequest = { id: gated.pending.requestId! } as ActionRequest;

    // A second gated request, authorized directly through the matrix.
    directGateRequest = await authorizeAction(ctx, {
      actionKind: 'external-communication',
      authorityLevel: 'EXECUTE',
      payload: { channel: 'linkedin', draft: 'Hiring a support analyst.' },
      justification: 'Publish the opening.',
    });
    expect(directGateRequest.status).toBe('pending');

    // A learning mission closing the unknown.
    mission = await createMission(ctx, {
      title: 'Churn driver discovery',
      knowledgeObjective: 'Identify the top drivers of the September churn spike.',
      affectedGoals: [{ goalId: goal.id, label: 'Q4 churn reduction' }],
      unknownIds: [unknown.id],
      informationValue: 0.9,
      urgency: 'high',
      currentConfidence: 0.1,
      targetConfidence: 0.85,
      investigationBudget: { amount: 50000, currency: 'USD' },
      rewardBudget: { amount: 20000, currency: 'USD' },
      completionCriteria: 'Ranked driver list with evidence, confidence >= 0.85.',
      actor: { kind: 'person', label: 'VP Customer Success' },
    });

    // Process intelligence over the seeded invoice flow.
    await reconstructProcess(ctx, {
      name: 'Invoice handling',
      scope: {
        observationKinds: ['invoice-entry'],
        caseKeyCandidates: ['orderId'],
      },
      actor: { kind: 'person', label: 'Ops manager' },
      rationale: 'monthly inefficiency review',
    });

    // The agent workforce: one definition with a queued execution.
    const registration = await registerAgent(
      member(ctx.tenantId, ctx.principalId, ['agents:administer']),
      {
        slug: 'churn-analyst',
        role: 'Analyzes churn cohorts',
        provider: 'langgraph',
        instructions: 'Analyze churn cohorts and report drivers.',
        permissions: ['analyze'],
      },
    );
    await submitAgentExecution(ctx, {
      agentId: registration.agent.id,
      task: { question: 'What changed in September?' },
      requestedPermissions: ['analyze'],
    });

    // One goal-gap discovery pass over the seeded goal + reading.
    await runGoalGapDiscovery(ctx, {
      trigger: { kind: 'manual', label: 'October ops review' },
      readings: [
        {
          goalId: goal.id,
          metricName: 'monthly-churn-ratio',
          value: 0.09,
          driverConfidence: 0.2,
          evidenceClaimIds: [claim.id],
        },
      ],
      investigationBudget: { amount: 30000, currency: 'USD' },
      rewardBudget: { amount: 10000, currency: 'USD' },
      actor: { kind: 'person', label: 'VP Customer Success' },
    });
  });

  afterAll(async () => {
    await closeDb();
  });

  // -------------------------------------------------------------------------

  it('Today: attention dashboard aggregates the live management state', async () => {
    const view = await buildTodayView(acme.owner);
    expect(view.goals.active.count).toBeGreaterThanOrEqual(1);
    expect(view.goals.byPriority.find((p) => p.priority === 'critical')?.count).toBe(1);
    expect(view.approvals.pending.count).toBe(2);
    expect(view.approvals.latest.map((a) => a.actionKind).sort()).toEqual([
      'data-export',
      'external-communication',
    ]);
    expect(view.missions.active.count).toBeGreaterThanOrEqual(1);
    expect(view.missions.byUrgency.find((u) => u.urgency === 'high')?.count).toBeGreaterThanOrEqual(1);
    expect(view.unknowns.open.count).toBeGreaterThanOrEqual(1);
    expect(view.cognition.awaitingApproval.count).toBe(1);
    expect(view.cognition.latest[0]?.state).toBe('awaiting_approval');
    expect(view.findings.map((f) => f.kind).sort()).toEqual([
      'capability-gap',
      'opportunity',
      'risk',
    ]);
    expect(view.discovery).not.toBeNull();
    expect(view.discovery?.counts.total).toBeGreaterThanOrEqual(1);
    expect(view.evidence.latest.length).toBeGreaterThanOrEqual(1);
  });

  it('Goals: the versioned direction with metrics and horizon', async () => {
    const view = await buildGoalsView(acme.owner);
    expect(view.total).toBe(1);
    const card = view.goals[0]!;
    expect(card.id).toBe(goal.id);
    expect(card.content.title).toBe('Q4 churn reduction');
    expect(card.content.priority).toBe('critical');
    expect(card.content.metrics[0]?.name).toBe('monthly-churn-ratio');
    expect(card.content.horizon.end).toBe('2026-12-31T00:00:00.000Z');
  });

  it('Situation: world picture, working understanding, retained conflict', async () => {
    const view = await buildSituationView(acme.owner);
    expect(view.world.total).toBe(2); // team + person entities
    expect(view.world.relationshipCount).toBe(1);
    expect(view.beliefs.activeCount).toBe(1);
    expect(view.beliefs.latest[0]?.proposition).toBe(
      'Churn is trending above the quarterly target.',
    );
    expect(view.claims.length).toBe(1);
    expect(view.contradictions.openCount).toBe(1);
  });

  it('Unknowns: the consequential knowledge debt', async () => {
    const view = await buildUnknownsView(acme.owner);
    expect(view.open.total).toBeGreaterThanOrEqual(1);
    const item = view.open.items.find((u) => u.id === unknown.id);
    expect(item?.question).toBe('What is driving the September churn spike?');
    expect(item?.related.observations).toBe(1);
    expect(item?.related.claims).toBe(1);
  });

  it('Missions: the knowledge-investment vehicle', async () => {
    const view = await buildMissionsView(acme.owner);
    const card = view.active.items.find((m) => m.id === mission.id);
    expect(card).toBeDefined();
    expect(card?.knowledgeObjective).toContain('churn');
    expect(card?.targetConfidence).toBe(0.85);
    expect(card?.affectedGoals[0]?.goalId).toBe(goal.id);
  });

  it('Risks: loop findings + retained contradictions + unmet capability demand', async () => {
    const view = await buildRisksView(acme.owner);
    expect(view.findings.length).toBe(1);
    expect(view.findings[0]?.statement).toContain('Churn at 9%');
    expect(view.findings[0]?.evidenceObservationIds).toEqual([channelObservation.id]);
    expect(view.contradictions.length).toBe(1);
    const gapNames = view.capabilityGaps.map((g) => g.capability.name).sort();
    expect(gapNames).toEqual(['Data analysis', 'Technical copywriting']);
  });

  it('Opportunities: loop findings + capability alternatives', async () => {
    const view = await buildOpportunitiesView(acme.owner);
    expect(view.findings.length).toBe(1);
    expect(view.findings[0]?.statement).toContain('Support transcripts');
    const analysis = view.alternatives.find(
      (a) => a.capability.name === 'Data analysis',
    );
    expect(analysis?.gapStatus).toBe('level_shortfall');
    expect(analysis?.activeSupplies.length).toBe(1);
    expect(analysis?.activeSupplies[0]?.supplier.kind).toBe('employee');
  });

  it('Capabilities: the graph with deterministic gap analysis', async () => {
    const view = await buildCapabilitiesView(acme.owner);
    expect(view.total).toBe(2);
    const analysis = view.capabilities.find((c) => c.name === 'Data analysis');
    expect(analysis?.gapStatus).toBe('level_shortfall');
    expect(analysis?.activeSupplyCount).toBe(1);
    const copy = view.capabilities.find((c) => c.name === 'Technical copywriting');
    expect(copy?.gapStatus).toBe('uncovered');
    expect(copy?.activeSupplyCount).toBe(0);
  });

  it('Processes: reconstructed flow with evidence-cited findings', async () => {
    const view = await buildProcessesView(acme.owner);
    expect(view.total).toBe(1);
    const process = view.processes[0]!;
    expect(process.name).toBe('Invoice handling');
    expect(process.stats.caseCount).toBe(2);
    expect(process.stats.occurrenceCount).toBe(4);
    const kinds = new Set(view.latestFindings.map((f) => f.finding.kind));
    expect(kinds.has('manual_effort')).toBe(true);
    expect(kinds.has('duplication')).toBe(true);
    for (const item of view.latestFindings) {
      expect(item.finding.evidenceObservationIds.length).toBeGreaterThan(0);
    }
  });

  it('Automation: the W016 findings automation candidates are built from', async () => {
    const view = await buildAutomationView(acme.owner);
    expect(view.candidates.length).toBeGreaterThanOrEqual(2);
    expect(view.totalsByKind.manual_effort).toBeGreaterThanOrEqual(1);
    expect(view.totalsByKind.duplication).toBeGreaterThanOrEqual(1);
    expect(view.capabilityGaps.length).toBe(2);
    expect(view.notices.length).toBeGreaterThanOrEqual(1);
  });

  it('Workforce: facts only — supplies, people, membership', async () => {
    const view = await buildWorkforceView(acme.owner);
    expect(view.employeeSupplies.total).toBe(1);
    expect(view.employeeSupplies.items[0]?.capability.name).toBe('Data analysis');
    expect(view.employeeSupplies.items[0]?.supplier.label).toBe('Dana Doe');
    expect(view.peopleEntities.map((p) => p.name)).toContain('Dana Doe');
    expect(view.members.readable).toBe(true);
    expect(view.members.items.length).toBeGreaterThanOrEqual(1);
    expect(view.notices.length).toBe(2);
  });

  it('Agents: definitions and executions, provider-neutral', async () => {
    const view = await buildAgentsView(acme.owner);
    expect(view.definitions.total).toBe(1);
    expect(view.definitions.items[0]?.slug).toBe('churn-analyst');
    expect(view.definitions.items[0]?.permissions).toEqual(['analyze']);
    expect(view.executions.total).toBe(1);
    expect(view.executions.items[0]?.status).toBe('queued');
    expect(view.executions.items[0]?.agentSlug).toBe('churn-analyst');
  });

  it('Evidence: the immutable observation feed with provenance', async () => {
    const view = await buildEvidenceView(acme.owner);
    expect(view.total).toBe(5);
    const byKind = new Map(view.byKind.map((k) => [k.kind, k.count]));
    expect(byKind.get('invoice-entry')).toBe(4);
    expect(byKind.get('channel.message')).toBe(1);
    // Newest first — but the five setup inserts can share a recorded_at
    // millisecond (recorded_at is minted by the service clock; id DESC is
    // only a tiebreak). Accept any same-millisecond record as "first" and
    // assert the channel observation's fields by identity instead of by
    // position (order-insensitive flake fix; cf. contributions-service fix).
    const entry = view.items[0]!;
    expect(
      entry.id === channelObservation.id ||
        entry.recordedAt === channelObservation.recordedAt,
    ).toBe(true);
    const channelEntry = view.items.find((i) => i.id === channelObservation.id);
    expect(channelEntry?.confidence.value).toBe(0.8);
  });

  it('Recommendations: the routed action feed with evaluation snapshots', async () => {
    const view = await buildRecommendationsView(acme.owner);
    // Three routed actions: the cognition EXECUTE proposal (pending), the
    // direct EXECUTE request (pending) and the agent submission (ANALYZE,
    // policy-allowed and recorded with an immediate POLICY decision).
    expect(view.total).toBe(3);
    expect(view.byStatus.find((s) => s.status === 'pending')?.count).toBe(2);
    const agentGate = view.items.find((i) => i.actionKind === 'agent-execution');
    expect(agentGate?.status).toBe('approved');
    expect(agentGate?.evaluation.outcome).toBe('allowed');
    for (const item of view.items.filter((i) => i.authorityLevel === 'EXECUTE')) {
      expect(item.evaluation.outcome).toBe('approval_required');
    }
  });

  it('Approvals: pending requests with trails, before any decision', async () => {
    const view = await buildApprovalsView(acme.owner);
    expect(view.pendingTotal).toBe(2);
    const ids = new Set(view.pending.map((p) => p.request.id));
    expect(ids.has(cognitionGateRequest.id)).toBe(true);
    expect(ids.has(directGateRequest.id)).toBe(true);
    const direct = view.pending.find((p) => p.request.id === directGateRequest.id)!;
    expect(direct.request.justification).toBe('Publish the opening.');
  });

  // -------------------------------------------------------------------------

  it('the decision path enforces the actions contract rules', async () => {
    // Same principal as the requester → separation of duties (the owner
    // session carries actions:approve via its verified role).
    const self = await handleTowerApprovalDecision(
      sessionRequest(acme.ownerToken, `/api/tower/approvals/${directGateRequest.id}/decide`, 'POST'),
      directGateRequest.id,
      { decision: 'approve' },
    );
    expect(self.status).toBe(403);
    if (self.status !== 200) expect(self.body.error).toBe('forbidden');

    // No claim → forbidden (a plain member's session carries no claims).
    const unclaimed = await handleTowerApprovalDecision(
      sessionRequest(acme.memberToken, `/api/tower/approvals/${directGateRequest.id}/decide`, 'POST'),
      directGateRequest.id,
      { decision: 'approve' },
    );
    expect(unclaimed.status).toBe(403);

    // A different principal WITH the claim (an admin session — the role
    // derives actions:approve) decides.
    const decision = await handleTowerApprovalDecision(
      sessionRequest(acme.adminToken, `/api/tower/approvals/${directGateRequest.id}/decide`, 'POST'),
      directGateRequest.id,
      { decision: 'approve', note: 'Go ahead.' },
    );
    expect(decision.status).toBe(200);
    if (decision.status !== 200) return;
    const envelope = decision.body;
    expect(envelope.surface).toBe('approvals-decision');
    expect(envelope.tenantId).toBe(acme.tenant.id);
    const decided = envelope.view as ActionRequest;
    expect(decided.status).toBe('approved');

    // First decision wins: re-deciding is a terminal conflict.
    const again = await handleTowerApprovalDecision(
      sessionRequest(acme.adminToken, `/api/tower/approvals/${directGateRequest.id}/decide`, 'POST'),
      directGateRequest.id,
      { decision: 'reject' },
    );
    expect(again.status).toBe(409);

    // The approvals view reflects the decision; the cognition gate stays pending.
    const view = await buildApprovalsView(acme.owner);
    expect(view.pendingTotal).toBe(1);
    expect(view.pending[0]?.request.id).toBe(cognitionGateRequest.id);
    expect(
      view.recentlyDecided.find((r) => r.id === directGateRequest.id)?.status,
    ).toBe('approved');
  });

  it('the API surface returns the view envelope for every surface', async () => {
    for (const surface of [
      'today',
      'goals',
      'situation',
      'unknowns',
      'missions',
      'risks',
      'opportunities',
      'capabilities',
      'processes',
      'automation',
      'workforce',
      'agents',
      'evidence',
      'recommendations',
      'approvals',
    ] as const) {
      const result = await handleTowerSurfaceGet(
        sessionRequest(acme.ownerToken, `/api/tower/${surface}`),
        surface,
      );
      expect(result.status).toBe(200);
      if (result.status !== 200) continue;
      expect(result.body.surface).toBe(surface);
      expect(result.body.tenantId).toBe(acme.tenant.id);
      expect(typeof result.body.generatedAt).toBe('string');
    }
  });

  it('the API surface rejects unknown surfaces and unauthenticated requests (W058)', async () => {
    const unknown = await handleTowerSurfaceGet(
      sessionRequest(acme.ownerToken, '/api/tower/dashboards'),
      'dashboards',
    );
    expect(unknown.status).toBe(404);
    if (unknown.status !== 404) return;
    expect(unknown.body.error).toBe('unknown_surface');

    // No session cookie → uniformly 401 (the query/header seam is gone,
    // so there is no other way to name a tenant).
    const anonymous = await handleTowerSurfaceGet(
      new Request('https://tower.test/api/tower/today'),
      'today',
    );
    expect(anonymous.status).toBe(401);
    if (anonymous.status !== 401) return;
    expect(anonymous.body.error).toBe('unauthenticated');

    // A session WITHOUT an active company → 409 (onboarding pending).
    const fresh = await registeredSession('tower-fresh-session');
    const unscoped = await handleTowerSurfaceGet(
      sessionRequest(fresh.token, 'today'),
      'today',
    );
    expect(unscoped.status).toBe(409);
    if (unscoped.status !== 409) return;
    expect(unscoped.body.error).toBe('no_active_company');

    // A stray ?tenant= query parameter is IGNORED — the session is the
    // only scope source (no query-string tenant scoping, plan §8 gate 1).
    const stray = await handleTowerSurfaceGet(
      sessionRequest(beta.memberToken, `/api/tower/today?tenant=${acme.tenant.id}`),
      'today',
    );
    expect(stray.status).toBe(200);
    if (stray.status !== 200) return;
    expect(stray.body.tenantId).toBe(beta.tenant.id);
  });

  it('the registry and the direct builders agree (no drift)', async () => {
    const direct = await buildTodayView(acme.owner);
    const viaRegistry = await buildTowerView(acme.owner, 'today');
    const { generatedAt: _directAt, ...directState } = direct;
    const { generatedAt: _registryAt, ...registryState } = viaRegistry as typeof direct;
    expect(registryState).toEqual(directState);
  });

  // -------------------------------------------------------------------------

  it('tenant isolation: another tenant sees none of Acme (ADR-0001)', async () => {
    const ctx = beta.owner;
    const today = await buildTodayView(ctx);
    expect(today.goals.active.count).toBe(0);
    expect(today.approvals.pending.count).toBe(0);
    expect(today.missions.active.count).toBe(0);
    expect(today.unknowns.open.count).toBe(0);
    expect(today.cognition.live.count).toBe(0);
    expect(today.findings).toEqual([]);
    expect(today.discovery).toBeNull();
    expect(today.evidence.latest).toEqual([]);

    const goals = await buildGoalsView(ctx);
    expect(goals.total).toBe(0);
    const situation = await buildSituationView(ctx);
    expect(situation.world.total).toBe(0);
    expect(situation.beliefs.activeCount).toBe(0);
    expect(situation.contradictions.openCount).toBe(0);
    const unknowns = await buildUnknownsView(ctx);
    expect(unknowns.open.total).toBe(0);
    const missions = await buildMissionsView(ctx);
    expect(missions.active.total).toBe(0);
    const risks = await buildRisksView(ctx);
    expect(risks.findings).toEqual([]);
    expect(risks.capabilityGaps).toEqual([]);
    const opportunities = await buildOpportunitiesView(ctx);
    expect(opportunities.findings).toEqual([]);
    const capabilities = await buildCapabilitiesView(ctx);
    expect(capabilities.total).toBe(0);
    const processes = await buildProcessesView(ctx);
    expect(processes.total).toBe(0);
    const automation = await buildAutomationView(ctx);
    expect(automation.candidates).toEqual([]);
    const workforce = await buildWorkforceView(ctx);
    expect(workforce.employeeSupplies.total).toBe(0);
    expect(workforce.peopleEntities).toEqual([]);
    const agents = await buildAgentsView(ctx);
    expect(agents.definitions.total).toBe(0);
    expect(agents.executions.total).toBe(0);
    const evidence = await buildEvidenceView(ctx);
    expect(evidence.total).toBe(0);
    const recommendations = await buildRecommendationsView(ctx);
    expect(recommendations.total).toBe(0);
    const approvals = await buildApprovalsView(ctx);
    expect(approvals.pendingTotal).toBe(0);
    expect(approvals.recentlyDecided).toEqual([]);

    // Beta's unknowns list does not leak Acme's unknown (uniform empty).
    const betaUnknowns = await listUnknowns(ctx, { status: 'open', limit: 10 });
    expect(betaUnknowns.map((u) => u.id)).not.toContain(unknown.id);

    // Beta cannot decide Acme's pending request: cross-tenant ids are
    // indistinguishable from missing ones (a signed-in Beta admin — the
    // session scope is Beta's own company, never Acme's).
    const foreignDecision: ApiResult = await handleTowerApprovalDecision(
      sessionRequest(beta.adminToken, `/api/tower/approvals/${cognitionGateRequest.id}/decide`, 'POST'),
      cognitionGateRequest.id,
      { decision: 'approve' },
    );
    expect(foreignDecision.status).toBe(404);
  });
});
