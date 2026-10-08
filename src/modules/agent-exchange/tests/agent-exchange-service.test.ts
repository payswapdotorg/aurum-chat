// Integration tests for the agent-exchange module against the embedded
// PostgreSQL (PGlite, `:memory:`) through the db port. Covers the W136
// acceptance (spec/work-items/WORK-ITEM-CATALOG.md §W136):
//
//   * RECRUITMENT USES MARKETPLACE/AGENT RECRUITMENT — an organization
//     member recruited through the real W022 path carries its APPROVED
//     agent-recruitment proposal (an awaiting_approval proposal is
//     refused); a marketplace package member references a REAL W028
//     package walked to INSTALLABLE through the governed chain (a
//     PUBLISHED-not-installable package and a foreign invisible draft
//     are both refused, uniformly);
//   * CONTEXT ROUTING IS MINIMAL AND EVIDENCE-LINKED — handoffs and
//     runs carry only the structural ContextPackage (one goal-matched
//     fingerprint ref + explicit evidence refs); a fingerprint of
//     another goal is refused (fingerprint_goal_mismatch), a divergent
//     fingerprint of the SAME goal is refused against a conditioned
//     plan (fingerprint_plan_mismatch);
//   * PROGRESS/RESULTS RETURN THROUGH NORMALIZED AGENT CONTRACTS — a
//     run references a REAL W021 execution submitted through the agents
//     contract: the live (queued) execution records PROGRESS, the
//     terminal (succeeded) execution records the RESULT, and both
//     freezes are VERBATIM the agents module's normalized values; a
//     mismatched assignee execution is refused (assignee governance);
//   * NO SECOND EXECUTION AUTHORITY — the public surface exports no
//     submit/dispatch/cancel/retry primitive (a structural regression
//     tripwire); a run for a nonexistent execution is refused with
//     NOTHING appended; handoffs/approvals/runs reject UPDATE/DELETE at
//     the storage level; tasks/members are immutable; the plan's only
//     legal UPDATE is the one-way terminal transition;
//   * THE GOVERNED APPROVALS — the W009 authority system decides: a
//     pending request is refused (approval_not_decided), an approved
//     decision and a REJECTED decision are both recorded with the
//     frozen verbatim snapshot (a rejection is retained evidence);
//   * TYPED ERROR PATHS — foreign/missing/archived/inactive references
//     read uniformly as their typed not-found codes (no existence
//     leak); the plan lifecycle is one-way terminal;
//   * TENANT ISOLATION (ADR-0001) — two tenants hold fully independent
//     exchange state: same-shaped plans coexist, foreign reads are
//     uniformly not-found, and neither lists nor evidence tails leak
//     across the boundary.
//
// TRANSACTION DISCIPLINE (the W134 lesson, binding): this harness NEVER
// opens a db.transaction of its own — the service opens exactly one
// transaction per mutation on the single PGlite connection, and a
// harness transaction around a service call would deadlock the embedded
// database. Every fixture below is built through the REAL public
// contracts (goals, context, epistemics, info-strategy, org-lab,
// agent-teams, agent-body, agents, marketplace, agent-recruitment,
// capabilities, actions, learning — the full W136 seam map), never by
// direct SQL writes (the storage-trigger probes are the deliberate
// exception: they prove the schema's own laws).

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { systemClock } from '@/infra/clock';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { runMigrations } from '../../../../scripts/migrate';

// The module under proof — through its contract only (rule (b)).
import * as exchangeContract from '../contract';
import { AgentExchangeError } from '../contract';
import type { AgentExchangeErrorCode, ExecutionPlan, ExecutionRun } from '../contract';

// The consumed seams, exercised as REAL records through their owning
// contracts (never re-derived, never direct-written):
//   goals W008 · context W134 · epistemics W004 · info-strategy W134 ·
//   org-lab W135 · agent-teams W023 · agent-body W133 · agents W021 ·
//   marketplace W028 · agent-recruitment W022 · capabilities W017 ·
//   actions W009 · learning W040
import { createGoal, reviseGoal } from '@/modules/goals/contract';
import type { Goal } from '@/modules/goals/contract';
import { deriveFingerprint } from '@/modules/context/contract';
import type { ContextFingerprint } from '@/modules/context/contract';
import { recordUnknown } from '@/modules/epistemics/contract';
import { defineStrategy } from '@/modules/info-strategy/contract';
import { registerCandidate, recordRecommendation } from '@/modules/org-lab/contract';
import type { OrgRecommendation } from '@/modules/org-lab/contract';
import { activateTeam, createTeam } from '@/modules/agent-teams/contract';
import type { Team } from '@/modules/agent-teams/contract';
import { createAgentBody, retireAgentBody } from '@/modules/agent-body/contract';
import type { AgentBody } from '@/modules/agent-body/contract';
import {
  getAgentExecution,
  registerAgent,
  runAgentExecution,
  setAgentTransport,
  submitAgentExecution,
  updateAgent,
} from '@/modules/agents/contract';
import type {
  AgentDefinition,
  AgentExecution,
  AgentRuntimeTransport,
} from '@/modules/agents/contract';
import {
  createPackage,
  makePackageInstallable,
  publishPackage,
  reviewPackage,
  runAutomatedVerification,
  submitPackage,
} from '@/modules/marketplace/contract';
import type { MarketplacePackage } from '@/modules/marketplace/contract';
import {
  createRecruitmentProposal,
  requestRecruitmentApproval,
  settleRecruitmentProposal,
} from '@/modules/agent-recruitment/contract';
import type { AgentRecruitmentProposal } from '@/modules/agent-recruitment/contract';
import { registerCapability, registerRequirement } from '@/modules/capabilities/contract';
import { authorizeAction, decideApproval, getActionRequest, setAuthorityPolicy } from '@/modules/actions/contract';
import type { ActionRequest } from '@/modules/actions/contract';
import {
  defineOutcome,
  recordMeasurement,
  settleOutcome,
} from '@/modules/learning/contract';
import type { Outcome } from '@/modules/learning/contract';

// Deterministic service-clock pins (the injectable clock discipline —
// same-millisecond writes must not decide what a proof shows).
const T_RUN_1 = '2026-10-08T09:00:00.000Z';
const T_HANDOFF_1 = '2026-10-08T09:10:00.000Z';
const T_RUN_2 = '2026-10-08T09:20:00.000Z';
const T_APPROVAL_1 = '2026-10-08T09:30:00.000Z';
const T_APPROVAL_2 = '2026-10-08T09:40:00.000Z';
const T_COMPLETE = '2026-10-08T10:00:00.000Z';

function pinClock(at: string): () => void {
  const realNow = systemClock.now;
  systemClock.now = () => new Date(at);
  return () => {
    systemClock.now = realNow;
  };
}

function member(
  tenantId: string,
  principalId = newId(),
  authority: string[] = [],
): TenantContext {
  return { tenantId, principalId, authority };
}

async function expectCode(
  code: AgentExchangeErrorCode,
  fn: () => Promise<unknown>,
): Promise<AgentExchangeError> {
  try {
    await fn();
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(AgentExchangeError);
    const typed = error as AgentExchangeError;
    expect(typed.code).toBe(code);
    return typed;
  }
}

// ---------------------------------------------------------------------------
// Fixture factories (all content caller-supplied — no industry or
// matching semantics live in these helpers, only the exact strings the
// fixtures declare and observe)
// ---------------------------------------------------------------------------

function goalInput(title: string) {
  return {
    title,
    objective: `Objective of ${title}`,
    desiredState: `Desired state of ${title}`,
    horizonEnd: '2027-12-31T00:00:00.000Z',
    owner: { kind: 'team' as const, label: 'operations' },
    priority: 'high' as const,
    successCriteria: 'Measurable success',
    actor: { kind: 'system' as const, label: 'w136-test' },
  };
}

function springObservations() {
  return {
    season: { window: 'spring', note: 'clear weather forecast' },
    duration: { durationClass: 'short' as const, estimatedSpan: '~6 weeks' },
    staffing: {
      headcount: 6,
      experienceMix: { novice: 5, intermediate: 1, expert: 0 },
      note: null,
    },
    workload: 'light' as const,
    capabilities: { available: ['ride-dispatch'], missing: [] },
    environment: { factors: ['urban'] },
    constraints: {
      budgetNote: 'lean budget',
      slaNote: '15m pickup SLA',
      qualityTarget: '4.8 stars',
      riskTolerance: 'risk-averse' as const,
      verificationRequirements: ['dual-signoff'],
    },
    evidenceFreshness: { maxEvidenceAge: '48h', criticalFreshSurfaces: ['traffic-api'] },
  };
}

function winterObservations() {
  return {
    season: { window: 'winter', note: null },
    duration: { durationClass: 'long' as const, estimatedSpan: '~5 months' },
    staffing: {
      headcount: 4,
      experienceMix: { novice: 0, intermediate: 1, expert: 3 },
      note: null,
    },
    workload: 'heavy' as const,
    capabilities: { available: ['freight-logistics'], missing: [] },
    environment: { factors: ['mountain'] },
    constraints: {
      budgetNote: 'capital available',
      slaNote: '24h freight SLA',
      qualityTarget: 'zero damage',
      riskTolerance: 'risk-tolerant' as const,
      verificationRequirements: ['carrier-insurance'],
    },
    evidenceFreshness: { maxEvidenceAge: '24h', criticalFreshSurfaces: ['weather-api'] },
  };
}

/** A single-tenant-agent crew (the org-lab solo composition). */
function soloComposition() {
  return {
    nodes: [{ nodeId: 'solo', kind: 'tenant-agent' as const, role: 'Solo operator' }],
  };
}

/** The W136 plan decomposition fixture. */
function planTasks() {
  return [
    { taskKey: 'survey', title: 'Survey the site' },
    { taskKey: 'dispatch', title: 'Dispatch crews', dependsOn: ['survey'], assigneeMemberKey: 'lead' },
    { taskKey: 'report', title: 'Report outcomes', dependsOn: ['dispatch'] },
  ];
}

/** Registers one active agent definition (the W021 execution side). */
async function registerTenantAgent(ctx: TenantContext, slug: string): Promise<AgentDefinition> {
  const registered = await registerAgent(ctx, {
    slug,
    displayName: slug,
    role: 'specialist execution',
    description: 'Executes plan tasks.',
    provider: 'openai-assistants',
    instructions: 'Execute the assigned task and report.',
    permissions: ['observe', 'analyze'],
    runtimeConfig: { assistantId: `asst_${slug}` },
  });
  return registered.agent;
}

/** One capability with a requirement gap (the W022 fixture precedent). */
async function capabilityWithGap(ctx: TenantContext, name: string): Promise<string> {
  const actor = { kind: 'person' as const, id: 'fixture-actor' };
  const capability = await registerCapability(ctx, { name, actor });
  await registerRequirement(ctx, {
    capabilityId: capability.id,
    source: { kind: 'manual', id: `${name}-need` },
    level: 0.7,
    capacity: null,
    actor,
  });
  return capability.id;
}

/** Creates + approves one recruitment proposal (the real W022 path). */
async function approvedRecruitmentProposal(
  ctx: TenantContext,
  capabilityId: string,
): Promise<AgentRecruitmentProposal> {
  const proposal = await createRecruitmentProposal(ctx, {
    title: 'Close the execution gap',
    capabilityId,
    rationale: 'The gap blocks plan execution.',
    evidenceObservationIds: ['00000000-0000-4000-8000-0000000000e1'],
    alternatives: [
      {
        kind: 'train',
        summary: 'Train an employee.',
        estimatedCostMinor: 450000,
        estimatedWeeks: 6,
        expectedLevel: 0.8,
      },
      {
        kind: 'recruit',
        summary: 'Recruit a specialist agent.',
        estimatedCostMinor: 120000,
        estimatedWeeks: 1,
        expectedLevel: 1,
        recommended: true,
        agentPermissions: ['observe', 'analyze'],
      },
    ],
  });
  const submitted = await requestRecruitmentApproval(ctx, {
    proposalId: proposal.id,
    justification: 'cheapest and fastest option for a bounded scope',
  });
  const approverCtx: TenantContext = {
    tenantId: ctx.tenantId,
    principalId: newId(),
    authority: ['actions:approve'],
  };
  await decideApproval(approverCtx, {
    requestId: submitted.approval.actionRequestId!,
    decision: 'approve',
  });
  return settleRecruitmentProposal(ctx, { proposalId: proposal.id });
}

/** Creates + submits one agent package for the vendor tenant. */
async function submittedAgentPackage(
  vendor: TenantContext,
  packageKey: string,
  version: string,
): Promise<MarketplacePackage> {
  const created = await createPackage(vendor, {
    kind: 'agent',
    packageKey,
    version,
    displayName: 'Site Surveyor',
    description: 'Surveys sites.',
    role: 'Site surveyor',
    instructions: 'Survey the site and report.',
    provider: 'langgraph',
    permissions: ['analyze', 'observe'],
  });
  return submitPackage(vendor, { packageId: created.id });
}

/** Walks a submitted package through the full governed chain to INSTALLABLE. */
async function toInstallable(pkg: MarketplacePackage, platform: TenantContext): Promise<MarketplacePackage> {
  await runAutomatedVerification(platform, { packageId: pkg.id });
  await reviewPackage(platform, { packageId: pkg.id, decision: 'approve', reason: 'Clean artifact' });
  await publishPackage(platform, { packageId: pkg.id });
  return makePackageInstallable(platform, { packageId: pkg.id });
}

/** Defines one OPEN learning outcome. */
async function openOutcome(ctx: TenantContext, metricName: string): Promise<Outcome> {
  return defineOutcome(ctx, {
    subject: { kind: 'recommendation', id: newId(), label: 'w136 probe recommendation' },
    metricName,
    metricUnit: 'count',
    direction: 'at_least',
    baseline: 0,
    expected: 10,
    horizon: null,
    affectedGoals: [],
    originExecutionId: null,
    actor: { kind: 'person', label: 'ops lead' },
    rationale: 'the w136 commitment',
  });
}

/** One organization candidate + recommendation for a goal (the W135 seam). */
async function recommendationForGoal(
  ctx: TenantContext,
  goal: Goal,
  fingerprint: ContextFingerprint,
): Promise<OrgRecommendation> {
  const candA = await registerCandidate(ctx, {
    slug: 'a-solo-crew',
    label: 'Solo crew',
    composition: soloComposition(),
  });
  const candB = await registerCandidate(ctx, {
    slug: 'b-solo-crew',
    label: 'Alternative crew',
    composition: soloComposition(),
  });
  const outcome = await openOutcome(ctx, 'surveys-completed');
  return recordRecommendation(ctx, {
    goalId: goal.id,
    fingerprintId: fingerprint.fingerprintId,
    knowledgeObjective: 'An organization that executes the survey plan',
    evaluationConfig: { criteria: [{ name: 'fit', weight: 1 }] },
    candidates: [
      { candidateId: candA.id, disposition: 'recommended', summary: 'Fits the observed context.' },
      { candidateId: candB.id, disposition: 'rejected', summary: 'Weaker fit.', rejectionReasons: ['no survey capability'] },
    ],
    expectedOutcomeIds: [outcome.id],
  });
}

// ---------------------------------------------------------------------------
// Tenants (dedicated per concern so count/order assertions stay deterministic)
// ---------------------------------------------------------------------------

const tenantGov = newId();
const tenantRelay = newId();
const tenantErr = newId();
const tenantIsoA = newId();
const tenantIsoB = newId();
const tenantVendor = newId();
const tenantPlatform = newId();

// --- tenantGov: the governed organization (acceptance law 1) ---
let goalGov: Goal;
let fpGov: ContextFingerprint;
let bodyGov: AgentBody;
let agentGov: AgentDefinition;
let proposalGov: AgentRecruitmentProposal;
let pkgInstallable: MarketplacePackage;
let pkgPublished: MarketplacePackage;
let pkgForeignDraft: MarketplacePackage;
let recommendationGov: OrgRecommendation;
let teamGov: Team;
let strategyGov: Awaited<ReturnType<typeof defineStrategy>>;
let planGov: ExecutionPlan;

// --- tenantRelay: handoffs + runs + approvals (laws 2 + 3 + 4) ---
let goalRelay: Goal;
let fpRelay: ContextFingerprint;
let fpRelayDivergent: ContextFingerprint;
let goalRelayOther: Goal;
let fpRelayOtherGoal: ContextFingerprint;
let agentLead: AgentDefinition;
let agentOther: AgentDefinition;
let planRelay: ExecutionPlan;
let planRelayB: ExecutionPlan;
let executionLive: AgentExecution;
let executionDone: AgentExecution;
let runProgress: ExecutionRun;
let runResult: ExecutionRun;
let outcomeOpenRelay: Outcome;
let outcomeSettledRelay: Outcome;
let approvedRequest: ActionRequest;
let rejectedRequest: ActionRequest;
let pendingRequest: ActionRequest;

// --- tenantErr: the typed error paths ---
let goalErr: Goal;
let goalErrArchived: Goal;
let goalErrOther: Goal;
let fpErr: ContextFingerprint;
let fpErrOtherGoal: ContextFingerprint;
let strategyErr: Awaited<ReturnType<typeof defineStrategy>>;
let recommendationErrGoal: OrgRecommendation;
let teamDraftErr: Awaited<ReturnType<typeof createTeam>>;
let bodyRetiredErr: AgentBody;
let agentDisabledErr: AgentDefinition;
let proposalPendingErr: AgentRecruitmentProposal;

// --- tenantIsoA / tenantIsoB: tenant isolation ---
let planIsoA: ExecutionPlan;
let planIsoB: ExecutionPlan;

beforeAll(async () => {
  await runMigrations(getDb());

  // The in-process fake transport (the sanctioned W021 wiring seam):
  // delivers the openai-assistants dialect the module's own adapter
  // normalizes — no real provider is contacted, and the canonical
  // result/cost still travel the REAL normalized contract.
  const fakeTransport: AgentRuntimeTransport = {
    send: async () => ({
      status: 'delivered' as const,
      payload: {
        id: 'run_w136_fixture',
        status: 'completed',
        output: [
          {
            type: 'message',
            content: [{ type: 'output_text', text: JSON.stringify({ surveyed: 3 }) }],
          },
        ],
        summary: 'Surveyed 3 sites',
        usage: { input_tokens: 120, output_tokens: 45 },
      },
      providerTaskId: 'run_w136_fixture',
      detail: null,
    }),
  };
  setAgentTransport(fakeTransport);

  // ------------------------------------------------------------------
  // tenantGov — the governed organization fixtures.
  // ------------------------------------------------------------------
  const gov = member(tenantGov);
  const govAdmin = member(tenantGov, newId(), ['agents:administer', 'actions:administer']);
  goalGov = await createGoal(gov, goalInput('Execute the spring site program'));
  fpGov = await deriveFingerprint(gov, {
    goalId: goalGov.id,
    task: { title: 'site program', kind: 'operations' },
    observations: springObservations(),
    derivedFrom: ['obs-gov-1'],
  });
  bodyGov = await createAgentBody(gov, { role: 'site-body', label: 'Site body' });
  agentGov = await registerTenantAgent(govAdmin, 'gov-specialist');
  proposalGov = await approvedRecruitmentProposal(
    gov,
    await capabilityWithGap(gov, 'site-survey-execution'),
  );

  // The marketplace chain: a vendor package walked to INSTALLABLE (the
  // governed W028 path), one held at PUBLISHED, and a foreign draft
  // that must stay invisible to this tenant.
  const vendor = member(tenantVendor, newId(), ['marketplace:submit']);
  const platform = member(tenantPlatform, newId(), ['marketplace:administer']);
  pkgInstallable = await toInstallable(
    await submittedAgentPackage(vendor, 'site-surveyor', '1.0.0'),
    platform,
  );
  pkgPublished = await submittedAgentPackage(vendor, 'site-surveyor-pub', '1.0.0');
  await runAutomatedVerification(platform, { packageId: pkgPublished.id });
  await reviewPackage(platform, { packageId: pkgPublished.id, decision: 'approve', reason: 'Clean' });
  pkgPublished = await publishPackage(platform, { packageId: pkgPublished.id });
  pkgForeignDraft = await submittedAgentPackage(vendor, 'foreign-draft', '0.1.0');

  // The W135 organization evidence for this goal.
  recommendationGov = await recommendationForGoal(gov, goalGov, fpGov);

  // The W023 team, walked to ACTIVE under a permissive policy (the
  // activation gate itself is W023's own tested surface).
  await setAuthorityPolicy(govAdmin, {
    actionKind: 'agent-recruitment',
    approvalLevels: [],
    forbiddenLevels: [],
  });
  const created = await createTeam(govAdmin, {
    slug: `gov-team-${newId().slice(0, 8)}`,
    displayName: 'Site team',
    description: 'Executes site programs.',
    topology: 'hierarchical',
    members: [{ agentId: agentGov.id, role: 'coordinator' }],
    objectives: [
      { key: 'delivery', objective: 'Deliver the site program', successCriteria: 'Done on time' },
    ],
    budget: { amountMinor: 500_000, currency: 'USD' },
    escalationRules: [{ trigger: 'authority-gap', route: 'management' }],
    ownerPrincipal: 'owner-principal-gov',
  });
  const activated = await activateTeam(govAdmin, { teamId: created.team.id });
  teamGov = activated.team;

  // The W134 strategy link.
  const unknownGov = await recordUnknown(gov, {
    question: 'Which organization executes the spring site program?',
    consequence: 'Not knowing this blocks the program decision.',
  });
  strategyGov = await defineStrategy(gov, {
    goalId: goalGov.id,
    fingerprintId: fpGov.fingerprintId,
    content: {
      knowledgeRequirements: [
        { unknownId: unknownGov.id, targetConfidence: 0.8, rationale: 'The program decision depends on it.' },
      ],
    },
  });

  // ------------------------------------------------------------------
  // tenantRelay — handoffs + runs + approvals fixtures.
  // ------------------------------------------------------------------
  const relay = member(tenantRelay);
  const relayAdmin = member(tenantRelay, newId(), ['agents:administer']);
  goalRelay = await createGoal(relay, goalInput('Relay the survey program'));
  goalRelayOther = await createGoal(relay, goalInput('A different program'));
  fpRelay = await deriveFingerprint(relay, {
    goalId: goalRelay.id,
    observations: springObservations(),
  });
  fpRelayDivergent = await deriveFingerprint(relay, {
    goalId: goalRelay.id,
    observations: winterObservations(),
  });
  fpRelayOtherGoal = await deriveFingerprint(relay, {
    goalId: goalRelayOther.id,
    observations: springObservations(),
  });
  agentLead = await registerTenantAgent(relayAdmin, 'relay-lead');
  agentOther = await registerTenantAgent(relayAdmin, 'relay-other');

  planRelay = await exchangeContract.createExecutionPlan(relay, {
    goalId: goalRelay.id,
    fingerprintId: fpRelay.fingerprintId,
    objective: 'Execute the survey program through the relay',
    tasks: planTasks(),
    members: [
      { memberKey: 'lead', kind: 'tenant-agent', role: 'Lead specialist', ref: agentLead.id },
      { memberKey: 'auditor', kind: 'human-capability', role: 'Program auditor' },
    ],
  });
  planRelayB = await exchangeContract.createExecutionPlan(relay, {
    goalId: goalRelay.id,
    objective: 'A second program (for the abandonment path)',
    tasks: [{ taskKey: 'probe', title: 'Probe' }],
  });

  // The W021 execution: submitted through the REAL agents contract at
  // OBSERVE (allowed by the built-in default), then dispatched once
  // through the fake transport to its terminal normalized result.
  executionLive = await submitAgentExecution(relay, {
    agentId: agentLead.id,
    task: { instruction: 'Survey the site', context: 'spring window' },
    requestedPermissions: ['observe'],
  });
  executionDone = await submitAgentExecution(relay, {
    agentId: agentLead.id,
    task: { instruction: 'Survey the site, final pass', context: 'spring window' },
    requestedPermissions: ['observe'],
  });
  executionDone = await runAgentExecution(relay, { executionId: executionDone.id });

  outcomeOpenRelay = await openOutcome(relay, 'surveys-completed-relay');
  outcomeSettledRelay = await openOutcome(relay, 'surveys-settled-relay');
  const measurement = await recordMeasurement(relay, {
    outcomeId: outcomeSettledRelay.id,
    value: 4,
    actor: { kind: 'system', label: 'metrics-warehouse' },
  });
  await settleOutcome(relay, {
    outcomeId: outcomeSettledRelay.id,
    measurementId: measurement.id,
    actor: { kind: 'person', label: 'ops lead' },
  });

  // The W009 authority decisions: approved, rejected, and one left
  // pending (all through the REAL actions contract).
  approvedRequest = await authorizeAction(relay, {
    actionKind: 'agent-execution',
    authorityLevel: 'EXECUTE',
    payload: { taskKey: 'dispatch', what: 'the program execution' },
    justification: 'the program is ready',
  });
  const relayApprover: TenantContext = {
    tenantId: tenantRelay,
    principalId: newId(),
    authority: ['actions:approve'],
  };
  await decideApproval(relayApprover, {
    requestId: approvedRequest.id,
    decision: 'approve',
  });
  rejectedRequest = await authorizeAction(relay, {
    actionKind: 'agent-execution',
    authorityLevel: 'EXECUTE',
    payload: { taskKey: 'survey', what: 'a rejected variant' },
    justification: 'a variant that will be refused',
  });
  await decideApproval(relayApprover, {
    requestId: rejectedRequest.id,
    decision: 'reject',
  });
  pendingRequest = await authorizeAction(relay, {
    actionKind: 'agent-execution',
    authorityLevel: 'EXECUTE',
    payload: { taskKey: 'report', what: 'a still-pending variant' },
    justification: 'nobody has decided this one',
  });

  // ------------------------------------------------------------------
  // tenantErr — the typed error path fixtures.
  // ------------------------------------------------------------------
  const errer = member(tenantErr);
  const errAdmin = member(tenantErr, newId(), ['agents:administer']);
  goalErr = await createGoal(errer, goalInput('The error-path program'));
  goalErrOther = await createGoal(errer, goalInput('The other-goal program'));
  goalErrArchived = await createGoal(errer, goalInput('The archived program'));
  await reviseGoal(errer, {
    goalId: goalErrArchived.id,
    status: 'archived',
    actor: { kind: 'system', label: 'w136-test' },
  });
  fpErr = await deriveFingerprint(errer, {
    goalId: goalErr.id,
    observations: springObservations(),
  });
  fpErrOtherGoal = await deriveFingerprint(errer, {
    goalId: goalErrOther.id,
    observations: springObservations(),
  });
  const unknownErr = await recordUnknown(errer, {
    question: 'What executes the error-path program?',
    consequence: 'Not knowing this blocks the test.',
  });
  strategyErr = await defineStrategy(errer, {
    goalId: goalErr.id,
    fingerprintId: fpErr.fingerprintId,
    content: {
      knowledgeRequirements: [
        { unknownId: unknownErr.id, targetConfidence: 0.8, rationale: 'The test depends on it.' },
      ],
    },
  });
  recommendationErrGoal = await recommendationForGoal(errer, goalErrOther, fpErrOtherGoal);
  teamDraftErr = await createTeam(errAdmin, {
    slug: `err-team-${newId().slice(0, 8)}`,
    displayName: 'Draft team',
    topology: 'hierarchical',
    members: [{ agentId: (await registerTenantAgent(errAdmin, 'err-agent')).id, role: 'coordinator' }],
    objectives: [{ key: 'probe', objective: 'Probe' }],
    budget: { amountMinor: 1000, currency: 'USD' },
    escalationRules: [{ trigger: 'authority-gap', route: 'management' }],
    ownerPrincipal: 'owner-principal-err',
  });
  bodyRetiredErr = await createAgentBody(errer, { role: 'retired-body', label: 'Retired body' });
  await retireAgentBody(errer, { bodyId: bodyRetiredErr.id });
  agentDisabledErr = await registerTenantAgent(errAdmin, 'err-disabled');
  await updateAgent(errAdmin, { agentId: agentDisabledErr.id, status: 'disabled' });
  proposalPendingErr = await createRecruitmentProposal(errer, {
    title: 'A pending acquisition',
    capabilityId: await capabilityWithGap(errer, 'pending-capability'),
    rationale: 'The gap blocks the error-path test.',
    evidenceObservationIds: [],
    alternatives: [
      {
        kind: 'recruit',
        summary: 'Recruit an agent.',
        estimatedCostMinor: 100000,
        estimatedWeeks: 1,
        expectedLevel: 1,
      },
      {
        kind: 'train',
        summary: 'Train an employee.',
        estimatedCostMinor: 100000,
        estimatedWeeks: 2,
        expectedLevel: 0.9,
      },
    ],
  });
  await requestRecruitmentApproval(errer, {
    proposalId: proposalPendingErr.id,
    justification: 'awaiting a decision on purpose',
  });

  // ------------------------------------------------------------------
  // tenantIsoA / tenantIsoB — isolation fixtures.
  // ------------------------------------------------------------------
  const isoA = member(tenantIsoA);
  const isoAAdmin = member(tenantIsoA, newId(), ['agents:administer']);
  const isoB = member(tenantIsoB);
  const isoBAdmin = member(tenantIsoB, newId(), ['agents:administer']);
  const goalIsoA = await createGoal(isoA, goalInput('The isolation program A'));
  const goalIsoB = await createGoal(isoB, goalInput('The isolation program B'));
  const agentIsoA = await registerTenantAgent(isoAAdmin, 'iso-a-agent');
  const agentIsoB = await registerTenantAgent(isoBAdmin, 'iso-b-agent');
  planIsoA = await exchangeContract.createExecutionPlan(isoA, {
    goalId: goalIsoA.id,
    objective: 'The same-shaped program',
    tasks: planTasks(),
    members: [
      { memberKey: 'lead', kind: 'tenant-agent', role: 'Lead', ref: agentIsoA.id },
    ],
  });
  planIsoB = await exchangeContract.createExecutionPlan(isoB, {
    goalId: goalIsoB.id,
    objective: 'The same-shaped program',
    tasks: planTasks(),
    members: [
      { memberKey: 'lead', kind: 'tenant-agent', role: 'Lead', ref: agentIsoB.id },
    ],
  });
});

afterAll(async () => {
  await closeDb();
});

// ---------------------------------------------------------------------------
// Acceptance law 1 — recruitment uses Marketplace/Agent Recruitment
// ---------------------------------------------------------------------------

describe('createExecutionPlan — the governed organization (acceptance law 1)', () => {
  it('records a plan with every composed link and the full member set', async () => {
    const gov = member(tenantGov);
    planGov = await exchangeContract.createExecutionPlan(gov, {
      goalId: goalGov.id,
      fingerprintId: fpGov.fingerprintId,
      strategyId: strategyGov.id,
      recommendationId: recommendationGov.id,
      teamId: teamGov.id,
      objective: 'Execute the spring site program through the governed organization',
      tasks: planTasks(),
      members: [
        {
          memberKey: 'body',
          kind: 'agent-body',
          role: 'Site body',
          ref: bodyGov.id,
        },
        {
          memberKey: 'lead',
          kind: 'tenant-agent',
          role: 'Lead specialist',
          ref: agentGov.id,
          recruitmentProposalId: proposalGov.id,
        },
        {
          memberKey: 'pack',
          kind: 'marketplace-agent-package',
          role: 'Survey package',
          ref: pkgInstallable.id,
        },
        { memberKey: 'steward', kind: 'human-capability', role: 'Program steward', ref: 'person-9' },
      ],
      note: 'the governed plan',
    });

    // The §11-style revision pin: the goal's version at creation.
    expect(planGov.goalVersion).toBe(goalGov.version);
    expect(planGov.status).toBe('active');
    expect(planGov.fingerprintId).toBe(fpGov.fingerprintId);
    expect(planGov.recommendationId).toBe(recommendationGov.id);
    expect(planGov.teamId).toBe(teamGov.id);
    expect(planGov.tasks.map((task) => task.taskKey)).toEqual(['survey', 'dispatch', 'report']);
    expect(planGov.tasks[1]!.dependsOn).toEqual(['survey']);
    expect(planGov.tasks.map((task) => task.position)).toEqual([1, 2, 3]);
    // Members read back keyed deterministically (member_key ASC).
    expect(planGov.members.map((m) => m.memberKey)).toEqual(['body', 'lead', 'pack', 'steward']);
    const lead = planGov.members.find((m) => m.memberKey === 'lead')!;
    expect(lead.recruitmentProposalId).toBe(proposalGov.id);
    expect(planGov.createdBy).toBe(gov.principalId);
  });

  it('refuses an unapproved recruitment provenance (recruitment uses APPROVED proposals only)', async () => {
    const errer = member(tenantErr);
    const errAgent = await registerTenantAgent(
      member(tenantErr, newId(), ['agents:administer']),
      'err-lead',
    );
    await expectCode('recruitment_not_approved', () =>
      exchangeContract.createExecutionPlan(errer, {
        goalId: goalErr.id,
        objective: 'A plan citing a pending proposal',
        tasks: [{ taskKey: 'probe', title: 'Probe' }],
        members: [
          {
            memberKey: 'lead',
            kind: 'tenant-agent',
            role: 'Lead',
            ref: errAgent.id,
            recruitmentProposalId: proposalPendingErr.id,
          },
        ],
      }),
    );
    await expectCode('recruitment_ref_not_found', () =>
      exchangeContract.createExecutionPlan(errer, {
        goalId: goalErr.id,
        objective: 'A plan citing a foreign proposal',
        tasks: [{ taskKey: 'probe', title: 'Probe' }],
        members: [
          {
            memberKey: 'lead',
            kind: 'tenant-agent',
            role: 'Lead',
            ref: errAgent.id,
            recruitmentProposalId: newId(),
          },
        ],
      }),
    );
  });

  it('refuses marketplace members below INSTALLABLE, uniformly (locks 26/27)', async () => {
    const gov = member(tenantGov);
    // PUBLISHED but not INSTALLABLE: publication never implies the right
    // to join an organization.
    await expectCode('marketplace_ref_not_found', () =>
      exchangeContract.createExecutionPlan(gov, {
        goalId: goalGov.id,
        objective: 'A plan with a published-only package',
        tasks: [{ taskKey: 'probe', title: 'Probe' }],
        members: [
          { memberKey: 'pack', kind: 'marketplace-agent-package', role: 'Pack', ref: pkgPublished.id },
        ],
      }),
    );
    // A foreign vendor's pre-publication draft is indistinguishable
    // from a missing package — no existence leak.
    await expectCode('marketplace_ref_not_found', () =>
      exchangeContract.createExecutionPlan(gov, {
        goalId: goalGov.id,
        objective: 'A plan with an invisible package',
        tasks: [{ taskKey: 'probe', title: 'Probe' }],
        members: [
          { memberKey: 'pack', kind: 'marketplace-agent-package', role: 'Pack', ref: pkgForeignDraft.id },
        ],
      }),
    );
    await expectCode('marketplace_ref_not_found', () =>
      exchangeContract.createExecutionPlan(gov, {
        goalId: goalGov.id,
        objective: 'A plan with a missing package',
        tasks: [{ taskKey: 'probe', title: 'Probe' }],
        members: [
          { memberKey: 'pack', kind: 'marketplace-extension-package', role: 'Pack', ref: newId() },
        ],
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Acceptance law 2 — context routing is minimal and evidence-linked
// ---------------------------------------------------------------------------

describe('the minimal context package (acceptance law 2)', () => {
  it('records a handoff carrying exactly the minimal evidence-linked package', async () => {
    const relay = member(tenantRelay);
    const unpin = pinClock(T_HANDOFF_1);
    try {
      const handoff = await exchangeContract.recordHandoff(relay, {
        planId: planRelay.id,
        taskKey: 'dispatch',
        fromMemberKey: 'lead',
        toMemberKey: 'auditor',
        context: {
          fingerprintId: fpRelay.fingerprintId,
          evidenceRefs: ['obs-survey-digest-1', 'obs-crew-list-2'],
          note: 'the survey digest only',
        },
        note: 'hand the survey evidence to the auditor',
      });
      expect(handoff.taskKey).toBe('dispatch');
      expect(handoff.fromMemberKey).toBe('lead');
      expect(handoff.toMemberKey).toBe('auditor');
      expect(handoff.context).toEqual({
        fingerprintId: fpRelay.fingerprintId,
        evidenceRefs: ['obs-survey-digest-1', 'obs-crew-list-2'],
        note: 'the survey digest only',
      });
      expect(handoff.recordedBy).toBe(relay.principalId);
      expect(handoff.recordedAt).toBe(T_HANDOFF_1);
    } finally {
      unpin();
    }
  });

  it('routes a context-free handoff (absent fingerprint is legal — minimal is the law)', async () => {
    const relay = member(tenantRelay);
    const handoff = await exchangeContract.recordHandoff(relay, {
      planId: planRelay.id,
      taskKey: 'report',
      fromMemberKey: 'auditor',
      toMemberKey: 'lead',
      context: { evidenceRefs: ['obs-final-report'] },
    });
    expect(handoff.context.fingerprintId).toBeNull();
  });

  it('refuses a fingerprint of another goal (incoherent routing)', async () => {
    const relay = member(tenantRelay);
    await expectCode('fingerprint_goal_mismatch', () =>
      exchangeContract.recordHandoff(relay, {
        planId: planRelay.id,
        taskKey: 'dispatch',
        fromMemberKey: 'lead',
        toMemberKey: 'auditor',
        context: { fingerprintId: fpRelayOtherGoal.fingerprintId },
      }),
    );
  });

  it('refuses a divergent fingerprint of the same goal against a conditioned plan', async () => {
    const relay = member(tenantRelay);
    await expectCode('fingerprint_plan_mismatch', () =>
      exchangeContract.recordHandoff(relay, {
        planId: planRelay.id,
        taskKey: 'dispatch',
        fromMemberKey: 'lead',
        toMemberKey: 'auditor',
        context: { fingerprintId: fpRelayDivergent.fingerprintId },
      }),
    );
  });

  it('refuses handoffs with unknown tasks or members, and self-handoffs', async () => {
    const relay = member(tenantRelay);
    await expectCode('task_not_found', () =>
      exchangeContract.recordHandoff(relay, {
        planId: planRelay.id,
        taskKey: 'ghost',
        fromMemberKey: 'lead',
        toMemberKey: 'auditor',
      }),
    );
    await expectCode('member_not_found', () =>
      exchangeContract.recordHandoff(relay, {
        planId: planRelay.id,
        taskKey: 'dispatch',
        fromMemberKey: 'lead',
        toMemberKey: 'ghost',
      }),
    );
    await expectCode('invalid_handoff_input', () =>
      exchangeContract.recordHandoff(relay, {
        planId: planRelay.id,
        taskKey: 'dispatch',
        fromMemberKey: 'lead',
        toMemberKey: 'lead',
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Acceptance law 3 — progress/results through normalized agent contracts
// ---------------------------------------------------------------------------

describe('recordExecutionRun — progress and results (acceptance law 3)', () => {
  it('records PROGRESS from the live normalized execution, VERBATIM', async () => {
    const relay = member(tenantRelay);
    const unpin = pinClock(T_RUN_1);
    try {
      runProgress = await exchangeContract.recordExecutionRun(relay, {
        planId: planRelay.id,
        taskKey: 'dispatch',
        agentExecutionId: executionLive.id,
        context: {
          fingerprintId: fpRelay.fingerprintId,
          evidenceRefs: ['obs-dispatch-brief'],
        },
        outcomeId: outcomeOpenRelay.id,
      });
      // The freeze is the agents module's own normalized state — no
      // transformation, no re-derivation.
      expect(runProgress.executionStatus).toBe(executionLive.status);
      expect(runProgress.executionStatus).toBe('queued');
      expect(runProgress.resultSummary).toBeNull();
      expect(runProgress.agentId).toBe(agentLead.id);
      expect(runProgress.agentExecutionId).toBe(executionLive.id);
      expect(runProgress.outcomeId).toBe(outcomeOpenRelay.id);
      expect(runProgress.recordedAt).toBe(T_RUN_1);
    } finally {
      unpin();
    }
  });

  it('records the RESULT from the terminal normalized execution, VERBATIM', async () => {
    const relay = member(tenantRelay);
    const fresh = await getAgentExecution(relay, { executionId: executionDone.id });
    const unpin = pinClock(T_RUN_2);
    try {
      runResult = await exchangeContract.recordExecutionRun(relay, {
        planId: planRelay.id,
        taskKey: 'dispatch',
        agentExecutionId: executionDone.id,
        context: { evidenceRefs: ['obs-dispatch-final'] },
      });
      expect(runResult.executionStatus).toBe('succeeded');
      expect(runResult.executionStatus).toBe(fresh.status);
      expect(runResult.resultSummary).toBe(fresh.result?.summary ?? null);
      expect(runResult.resultSummary).toBe('Surveyed 3 sites');
      expect(runResult.costMinor).toBe(fresh.costMinor);
      expect(runResult.attemptsCount).toBe(fresh.attemptsCount);
      expect(runResult.attemptsCount).toBe(1);
      expect(runResult.executionCompletedAt).toBe(fresh.completedAt);
      expect(runResult.outcomeId).toBeNull();
    } finally {
      unpin();
    }
  });

  it('lists the run timeline in evidence order, filterable by task', async () => {
    const relay = member(tenantRelay);
    const runs = await exchangeContract.listExecutionRuns(relay, { planId: planRelay.id });
    expect(runs.map((run) => run.recordedAt)).toEqual([T_RUN_1, T_RUN_2]);
    const dispatchRuns = await exchangeContract.listExecutionRuns(relay, {
      planId: planRelay.id,
      taskKey: 'dispatch',
    });
    expect(dispatchRuns).toHaveLength(2);
    const reportRuns = await exchangeContract.listExecutionRuns(relay, {
      planId: planRelay.id,
      taskKey: 'report',
    });
    expect(reportRuns).toHaveLength(0);
  });

  it('enforces assignee governance (runs serve the declared organization)', async () => {
    const relay = member(tenantRelay);
    const foreign = await submitAgentExecution(relay, {
      agentId: agentOther.id,
      task: { instruction: 'Someone else entirely' },
      requestedPermissions: ['observe'],
    });
    await expectCode('execution_agent_mismatch', () =>
      exchangeContract.recordExecutionRun(relay, {
        planId: planRelay.id,
        taskKey: 'dispatch',
        agentExecutionId: foreign.id,
      }),
    );
  });

  it('refuses a nonexistent execution with NOTHING appended', async () => {
    const relay = member(tenantRelay);
    await expectCode('execution_not_found', () =>
      exchangeContract.recordExecutionRun(relay, {
        planId: planRelay.id,
        taskKey: 'dispatch',
        agentExecutionId: newId(),
      }),
    );
    const runs = await exchangeContract.listExecutionRuns(relay, { planId: planRelay.id });
    expect(runs).toHaveLength(2);
  });

  it('refuses a settled outcome link (OPEN commitments only)', async () => {
    const relay = member(tenantRelay);
    await expectCode('invalid_outcome_ref', () =>
      exchangeContract.recordExecutionRun(relay, {
        planId: planRelay.id,
        taskKey: 'dispatch',
        agentExecutionId: executionLive.id,
        outcomeId: outcomeSettledRelay.id,
      }),
    );
    await expectCode('invalid_outcome_ref', () =>
      exchangeContract.recordExecutionRun(relay, {
        planId: planRelay.id,
        taskKey: 'dispatch',
        agentExecutionId: executionLive.id,
        outcomeId: newId(),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Acceptance law 4 — no second execution authority
// ---------------------------------------------------------------------------

describe('no second execution authority (acceptance law 4)', () => {
  it('exposes no execution primitive on the public surface (structural tripwire)', () => {
    const surface = Object.keys(exchangeContract);
    for (const banned of [
      'submitAgentExecution',
      'runAgentExecution',
      'cancelAgentExecution',
      'setAgentTransport',
      'registerAgent',
      'updateAgent',
      'installPackage',
      'decideApproval',
      'authorizeAction',
    ]) {
      expect(surface).not.toContain(banned);
    }
    // The surface is exactly the recording + reading contract: every
    // declared operation is a record/transition/read function.
    for (const op of [
      'createExecutionPlan',
      'completeExecutionPlan',
      'abandonExecutionPlan',
      'recordHandoff',
      'recordApproval',
      'recordExecutionRun',
      'getExecutionPlan',
      'listExecutionPlans',
      'listExecutionRuns',
      'listHandoffs',
      'listApprovals',
    ] as const) {
      expect(typeof exchangeContract[op]).toBe('function');
    }
  });

  it('keeps handoffs and runs append-only at the storage level', async () => {
    const db = getDb();
    await expect(
      db.query(`UPDATE execution_plan_runs SET result_summary = 'forged'`),
    ).rejects.toThrow(/append-only/);
    await expect(db.query(`DELETE FROM execution_plan_handoffs`)).rejects.toThrow(/append-only/);
    await expect(db.query(`TRUNCATE execution_plan_runs`)).rejects.toThrow(/append-only/);
  });

  it('keeps tasks and members immutable, and the plan content unrewritable', async () => {
    const db = getDb();
    await expect(
      db.query(`UPDATE execution_plan_tasks SET title = 'forged'`),
    ).rejects.toThrow(/append-only/);
    await expect(
      db.query(`UPDATE execution_plan_members SET role = 'forged'`),
    ).rejects.toThrow(/append-only/);
    await expect(
      db.query(`UPDATE execution_plans SET objective = 'forged'`),
    ).rejects.toThrow(/immutable/);
    await expect(db.query(`DELETE FROM execution_plans`)).rejects.toThrow(/lifecycle-managed/);
  });
});

// ---------------------------------------------------------------------------
// The governed approvals — the authority system decides, the exchange records
// ---------------------------------------------------------------------------

describe('recordApproval — governed authority records', () => {
  it('refuses a still-pending request (the exchange records decisions only)', async () => {
    const relay = member(tenantRelay);
    await expectCode('approval_not_decided', () =>
      exchangeContract.recordApproval(relay, {
        planId: planRelay.id,
        taskKey: 'report',
        actionRequestId: pendingRequest.id,
      }),
    );
  });

  it('records the APPROVED decision with the frozen verbatim snapshot', async () => {
    const relay = member(tenantRelay);
    // The decision snapshot must match the request's CURRENT (terminal)
    // state — re-read through the actions contract, not the stale
    // authorization-time return.
    const fresh = await getActionRequest(relay, { requestId: approvedRequest.id });
    expect(fresh.status).toBe('approved');
    expect(fresh.decidedAt).not.toBeNull();
    const unpin = pinClock(T_APPROVAL_1);
    try {
      const approval = await exchangeContract.recordApproval(relay, {
        planId: planRelay.id,
        taskKey: 'dispatch',
        actionRequestId: approvedRequest.id,
      });
      expect(approval.decision).toEqual({
        actionRequestId: fresh.id,
        actionKind: fresh.actionKind,
        authorityLevel: fresh.authorityLevel,
        status: 'approved',
        requestedBy: fresh.requestedBy,
        requestedAt: fresh.requestedAt,
        decidedAt: fresh.decidedAt,
      });
      expect(approval.decision.actionKind).toBe('agent-execution');
      expect(approval.decision.authorityLevel).toBe('EXECUTE');
      expect(approval.recordedAt).toBe(T_APPROVAL_1);
    } finally {
      unpin();
    }
  });

  it('records the REJECTED decision as retained evidence (a rejection is evidence too)', async () => {
    const relay = member(tenantRelay);
    const unpin = pinClock(T_APPROVAL_2);
    try {
      const approval = await exchangeContract.recordApproval(relay, {
        planId: planRelay.id,
        actionRequestId: rejectedRequest.id,
      });
      expect(approval.taskKey).toBeNull(); // plan-scoped
      expect(approval.decision.status).toBe('rejected');
    } finally {
      unpin();
    }
    const approvals = await exchangeContract.listApprovals(relay, { planId: planRelay.id });
    expect(approvals.map((a) => a.decision.status)).toEqual(['approved', 'rejected']);
    const dispatchApprovals = await exchangeContract.listApprovals(relay, {
      planId: planRelay.id,
      taskKey: 'dispatch',
    });
    expect(dispatchApprovals).toHaveLength(1);
  });

  it('refuses unknown requests and unknown plans/tasks uniformly', async () => {
    const relay = member(tenantRelay);
    await expectCode('approval_not_found', () =>
      exchangeContract.recordApproval(relay, {
        planId: planRelay.id,
        actionRequestId: newId(),
      }),
    );
    await expectCode('plan_not_found', () =>
      exchangeContract.recordApproval(relay, {
        planId: newId(),
        actionRequestId: approvedRequest.id,
      }),
    );
    await expectCode('task_not_found', () =>
      exchangeContract.recordApproval(relay, {
        planId: planRelay.id,
        taskKey: 'ghost',
        actionRequestId: approvedRequest.id,
      }),
    );
  });

  it('keeps the recorded approvals append-only at the storage level', async () => {
    // Both approval records exist by now (approved + rejected) — the
    // row-level trigger must fire on every matched row.
    const db = getDb();
    await expect(
      db.query(`UPDATE execution_plan_approvals SET task_key = 'forged'`),
    ).rejects.toThrow(/append-only/);
    await expect(db.query(`DELETE FROM execution_plan_approvals`)).rejects.toThrow(
      /append-only/,
    );
    await expect(db.query(`TRUNCATE execution_plan_approvals`)).rejects.toThrow(/append-only/);
    // Nothing was dropped: the evidence is intact.
    const relay = member(tenantRelay);
    const approvals = await exchangeContract.listApprovals(relay, { planId: planRelay.id });
    expect(approvals.map((a) => a.decision.status)).toEqual(['approved', 'rejected']);
  });
});

// ---------------------------------------------------------------------------
// The plan lifecycle — one-way terminal
// ---------------------------------------------------------------------------

describe('the plan lifecycle', () => {
  it('completes a plan with the retained note, then refuses every further transition', async () => {
    const relay = member(tenantRelay);
    const unpin = pinClock(T_COMPLETE);
    try {
      const completed = await exchangeContract.completeExecutionPlan(relay, {
        planId: planRelay.id,
        note: 'all program tasks delivered and evidenced',
      });
      expect(completed.status).toBe('completed');
      expect(completed.completedAt).toBe(T_COMPLETE);
      expect(completed.lifecycleNote).toBe('all program tasks delivered and evidenced');
      expect(completed.abandonedAt).toBeNull();
    } finally {
      unpin();
    }
    await expectCode('plan_already_terminal', () =>
      exchangeContract.completeExecutionPlan(relay, {
        planId: planRelay.id,
        note: 'completing twice is illegal',
      }),
    );
    await expectCode('plan_already_terminal', () =>
      exchangeContract.abandonExecutionPlan(relay, {
        planId: planRelay.id,
        reason: 'switching to abandonment after completion is illegal',
      }),
    );
    // The completed plan no longer accepts relay or run observations.
    await expectCode('plan_not_active', () =>
      exchangeContract.recordHandoff(relay, {
        planId: planRelay.id,
        taskKey: 'dispatch',
        fromMemberKey: 'lead',
        toMemberKey: 'auditor',
      }),
    );
    await expectCode('plan_not_active', () =>
      exchangeContract.recordExecutionRun(relay, {
        planId: planRelay.id,
        taskKey: 'dispatch',
        agentExecutionId: executionLive.id,
      }),
    );
  });

  it('abandons a plan with the retained reason', async () => {
    const relay = member(tenantRelay);
    const abandoned = await exchangeContract.abandonExecutionPlan(relay, {
      planId: planRelayB.id,
      reason: 'the program was cancelled',
    });
    expect(abandoned.status).toBe('abandoned');
    expect(abandoned.abandonedAt).not.toBeNull();
    expect(abandoned.lifecycleNote).toBe('the program was cancelled');
    expect(abandoned.completedAt).toBeNull();
    await expectCode('plan_already_terminal', () =>
      exchangeContract.abandonExecutionPlan(relay, {
        planId: planRelayB.id,
        reason: 'abandoning twice is illegal',
      }),
    );
  });

  it('lists plans newest-first with counts and filters', async () => {
    const relay = member(tenantRelay);
    const plans = await exchangeContract.listExecutionPlans(relay, {});
    // planRelay (completed) was created before planRelayB (abandoned):
    // newest first means B, then the relay plan.
    expect(plans.map((p) => p.id)).toEqual([planRelayB.id, planRelay.id]);
    expect(plans[0]!.status).toBe('abandoned');
    expect(plans[1]!.taskCount).toBe(3);
    expect(plans[1]!.memberCount).toBe(2);
    const active = await exchangeContract.listExecutionPlans(relay, { status: 'active' });
    expect(active).toHaveLength(0);
    const byGoal = await exchangeContract.listExecutionPlans(relay, { goalId: goalRelay.id });
    expect(byGoal).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// The typed error paths (uniform not-founds — no existence leak)
// ---------------------------------------------------------------------------

describe('the typed error paths', () => {
  it('refuses goal-side problems uniformly', async () => {
    const errer = member(tenantErr);
    await expectCode('goal_not_found', () =>
      exchangeContract.createExecutionPlan(errer, {
        goalId: newId(),
        objective: 'A plan for a missing goal',
        tasks: [{ taskKey: 'probe', title: 'Probe' }],
      }),
    );
    await expectCode('goal_not_found', () =>
      exchangeContract.createExecutionPlan(errer, {
        goalId: goalErrArchived.id,
        objective: 'A plan for an archived goal',
        tasks: [{ taskKey: 'probe', title: 'Probe' }],
      }),
    );
    await expectCode('fingerprint_not_found', () =>
      exchangeContract.createExecutionPlan(errer, {
        goalId: goalErr.id,
        fingerprintId: newId(),
        objective: 'A plan with a foreign fingerprint',
        tasks: [{ taskKey: 'probe', title: 'Probe' }],
      }),
    );
    await expectCode('fingerprint_goal_mismatch', () =>
      exchangeContract.createExecutionPlan(errer, {
        goalId: goalErr.id,
        fingerprintId: fpErrOtherGoal.fingerprintId,
        objective: 'A plan conditioned on the same tenant\'s other-goal fingerprint',
        tasks: [{ taskKey: 'probe', title: 'Probe' }],
      }),
    );
    await expectCode('strategy_not_found', () =>
      exchangeContract.createExecutionPlan(errer, {
        goalId: goalErr.id,
        strategyId: newId(),
        objective: 'A plan with a foreign strategy',
        tasks: [{ taskKey: 'probe', title: 'Probe' }],
      }),
    );
  });

  it('refuses organization-side problems uniformly', async () => {
    const errer = member(tenantErr);
    await expectCode('recommendation_not_found', () =>
      exchangeContract.createExecutionPlan(errer, {
        goalId: goalErr.id,
        recommendationId: newId(),
        objective: 'A plan with a foreign recommendation',
        tasks: [{ taskKey: 'probe', title: 'Probe' }],
      }),
    );
    await expectCode('recommendation_goal_mismatch', () =>
      exchangeContract.createExecutionPlan(errer, {
        goalId: goalErr.id,
        recommendationId: recommendationErrGoal.id,
        objective: 'A plan executing goal G on goal H\'s organization',
        tasks: [{ taskKey: 'probe', title: 'Probe' }],
      }),
    );
    await expectCode('team_not_found', () =>
      exchangeContract.createExecutionPlan(errer, {
        goalId: goalErr.id,
        teamId: newId(),
        objective: 'A plan with a foreign team',
        tasks: [{ taskKey: 'probe', title: 'Probe' }],
      }),
    );
    // A DRAFT team is not an active organization.
    await expectCode('team_not_found', () =>
      exchangeContract.createExecutionPlan(errer, {
        goalId: goalErr.id,
        teamId: teamDraftErr.team.id,
        objective: 'A plan on a draft team',
        tasks: [{ taskKey: 'probe', title: 'Probe' }],
      }),
    );
    await expectCode('body_ref_not_found', () =>
      exchangeContract.createExecutionPlan(errer, {
        goalId: goalErr.id,
        objective: 'A plan with a foreign body',
        tasks: [{ taskKey: 'probe', title: 'Probe' }],
        members: [{ memberKey: 'body', kind: 'agent-body', role: 'Body', ref: newId() }],
      }),
    );
    await expectCode('body_ref_inactive', () =>
      exchangeContract.createExecutionPlan(errer, {
        goalId: goalErr.id,
        objective: 'A plan with a retired body',
        tasks: [{ taskKey: 'probe', title: 'Probe' }],
        members: [{ memberKey: 'body', kind: 'agent-body', role: 'Body', ref: bodyRetiredErr.id }],
      }),
    );
    await expectCode('agent_ref_not_found', () =>
      exchangeContract.createExecutionPlan(errer, {
        goalId: goalErr.id,
        objective: 'A plan with a foreign agent',
        tasks: [{ taskKey: 'probe', title: 'Probe' }],
        members: [{ memberKey: 'lead', kind: 'tenant-agent', role: 'Lead', ref: newId() }],
      }),
    );
    await expectCode('agent_ref_inactive', () =>
      exchangeContract.createExecutionPlan(errer, {
        goalId: goalErr.id,
        objective: 'A plan with a disabled agent',
        tasks: [{ taskKey: 'probe', title: 'Probe' }],
        members: [
          { memberKey: 'lead', kind: 'tenant-agent', role: 'Lead', ref: agentDisabledErr.id },
        ],
      }),
    );
  });

  it('refuses plan-side problems uniformly (reads and transitions)', async () => {
    const relay = member(tenantRelay);
    await expectCode('plan_not_found', () =>
      exchangeContract.getExecutionPlan(relay, { planId: newId() }),
    );
    await expectCode('plan_not_found', () =>
      exchangeContract.completeExecutionPlan(relay, { planId: newId(), note: 'nope' }),
    );
    // The plan-scoped list views follow the filtered-list house style
    // (org-lab listRecommendations): an unknown plan is an EMPTY list,
    // never an existence leak.
    const runs = await exchangeContract.listExecutionRuns(relay, { planId: newId() });
    expect(runs).toEqual([]);
  });

  it('captures the W134 strategy link for a plan (the beforeAll fixture id)', async () => {
    // strategyErr was created for goalErr; a plan linking it must pass
    // the write-time gate (readable) — proving the strategy seam.
    const errer = member(tenantErr);
    const plan = await exchangeContract.createExecutionPlan(errer, {
      goalId: goalErr.id,
      strategyId: strategyErr.id,
      objective: 'A plan with the real strategy link',
      tasks: [{ taskKey: 'probe', title: 'Probe' }],
    });
    expect(plan.strategyId).toBe(strategyErr.id);
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation (ADR-0001)
// ---------------------------------------------------------------------------

describe('tenant isolation', () => {
  it('holds fully independent exchange state across two tenants', async () => {
    const isoA = member(tenantIsoA);
    const isoB = member(tenantIsoB);
    // Same-shaped plans coexist in both tenants.
    expect(planIsoA.tasks.map((t) => t.taskKey)).toEqual(planIsoB.tasks.map((t) => t.taskKey));
    // Foreign reads are uniformly not-found; foreign list views are
    // uniformly EMPTY (the filtered-list invisibility law).
    await expectCode('plan_not_found', () =>
      exchangeContract.getExecutionPlan(isoA, { planId: planIsoB.id }),
    );
    const foreignRuns = await exchangeContract.listExecutionRuns(isoB, { planId: planIsoA.id });
    expect(foreignRuns).toEqual([]);
    const foreignHandoffs = await exchangeContract.listHandoffs(isoA, { planId: planIsoB.id });
    expect(foreignHandoffs).toEqual([]);
    await expectCode('plan_not_found', () =>
      exchangeContract.recordHandoff(isoA, {
        planId: planIsoB.id,
        taskKey: 'dispatch',
        fromMemberKey: 'lead',
        toMemberKey: 'ghost-member',
      }),
    );
    // Lists never leak across the boundary.
    const plansA = await exchangeContract.listExecutionPlans(isoA, {});
    expect(plansA.map((p) => p.id)).toEqual([planIsoA.id]);
    const plansB = await exchangeContract.listExecutionPlans(isoB, {});
    expect(plansB.map((p) => p.id)).toEqual([planIsoB.id]);
    // The evidence tails stay tenant-scoped.
    const handoffsA = await exchangeContract.listHandoffs(isoA, { planId: planIsoA.id });
    expect(handoffsA).toHaveLength(0);
    const approvalsB = await exchangeContract.listApprovals(isoB, { planId: planIsoB.id });
    expect(approvalsB).toHaveLength(0);
  });
});
