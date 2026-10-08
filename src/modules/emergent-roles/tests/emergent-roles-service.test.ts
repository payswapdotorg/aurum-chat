// Service proofs for the emergent-roles module against the embedded
// PostgreSQL (PGlite, `:memory:`) through the db port. Test-locks EVERY
// acceptance clause of W138 (spec/work-items/WORK-ITEM-CATALOG.md §W138):
//
//   * PROPOSALS CARRY EVIDENCE, DEMANDS, ALTERNATIVES AND EVALUATION —
//     gap evidence is aggregated from the three REAL recurring-gap
//     signals through their owning contracts (a settled-MISSED W040
//     outcome, a NEGATIVELY-calibrated W135 recommendation — built by
//     settling the recommendation's expected outcome as missed and
//     running the REAL calibration loop — and a FAILED W136 execution
//     run, produced by dispatching a REAL W021 execution through a
//     rejecting in-process transport); a proposal carries ≥2 of those
//     citations, typed W017 capability demands, alternatives EACH with
//     its retained evaluation, and the structured evaluation summary;
//     non-signals (open/met outcomes, uncalibrated/positive
//     recommendations, succeeded runs) are refused with their typed
//     codes; one upstream record is one gap (double-citation refused).
//   * PUBLICATION/INSTALL/ACTIVATION REMAIN GOVERNED — the marketplace
//     submission cites a REAL W028 AgentPackage walked to INSTALLABLE
//     through the marketplace's own governed chain (vendor
//     createPackage → submitPackage → automated verification →
//     platform review → publishPackage → makePackageInstallable), with
//     the key/version/state FROZEN verbatim and the package's state
//     UNMOVED by the recording (this module advances nothing); the
//     activation cites a REAL APPROVED W022 recruitment proposal (a
//     still-awaiting-approval one is refused); the review records a
//     TERMINAL W009 decision snapshot verbatim (pending is refused; a
//     rejection is retained evidence exactly like an approval); the
//     module surface exports NO publication/install/activation
//     primitive (structural tripwire).
//   * THE LAB CANNOT SELF-PUBLISH OR SELF-ACTIVATE — the principal that
//     recorded an org-lab-sourced proposal is refused, with typed
//     errors, as the recorder of its marketplace submission
//     (`lab_cannot_self_publish`) and of its activation
//     (`lab_cannot_self_activate`); a different governed principal
//     records both successfully; the storage triggers make the bad rows
//     unrepresentable even for callers bypassing the service (direct
//     INSERT probes).
//   * TYPED ERROR PATHS — foreign/missing/retired references read
//     uniformly as their typed not-found codes (no existence leak);
//     the proposal lifecycle is one-way (draft → under_review →
//     approved | rejected → fulfilled, with the withdrawn exit), with
//     FOR-UPDATE staleness re-checks (sequentially, the racing second
//     call is refused); evidence/reviews/submissions/activations are
//     append-only at the storage level; proposal content is immutable.
//   * TENANT ISOLATION (ADR-0001) — two tenants hold fully independent
//     emergence state: the same slug coexists, foreign reads are
//     uniformly not-found, and neither lists nor records leak across
//     the boundary.
//
// TRANSACTION DISCIPLINE (the W134 lesson, binding): this harness NEVER
// opens a db.transaction of its own — the service opens exactly one
// transaction per mutation on the single PGlite connection. Every
// fixture below is built through the REAL public contracts (goals,
// context, org-lab, agents, agent-exchange, marketplace, extensions,
// agent-recruitment, capabilities, actions, learning — the W138 seam
// map), never by direct SQL writes (the storage-trigger probes are the
// deliberate exception: they prove the schema's own laws).

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
import * as emergent from '../contract';
import { EmergentRolesError } from '../contract';
import type { EmergentRolesErrorCode } from '../contract';

// The consumed seams, exercised as REAL records through their owning
// contracts (never re-derived, never direct-written):
//   goals W008 · context W134 · org-lab W135 · agents W021 ·
//   agent-exchange W136 · marketplace W028 · extensions W025 ·
//   agent-recruitment W022 · capabilities W017 · actions W009 ·
//   learning W040
import { createGoal } from '@/modules/goals/contract';
import type { Goal } from '@/modules/goals/contract';
import { deriveFingerprint } from '@/modules/context/contract';
import { registerCandidate, recordCalibration, recordRecommendation } from '@/modules/org-lab/contract';
import type { OrgRecommendation } from '@/modules/org-lab/contract';
import {
  registerAgent,
  runAgentExecution,
  setAgentTransport,
  submitAgentExecution,
} from '@/modules/agents/contract';
import type { AgentDefinition, AgentRuntimeTransport } from '@/modules/agents/contract';
import * as exchangeContract from '@/modules/agent-exchange/contract';
import type { ExecutionPlan, ExecutionRun } from '@/modules/agent-exchange/contract';
import {
  createPackage,
  getPackage,
  makePackageInstallable,
  publishPackage,
  reviewPackage,
  runAutomatedVerification,
  submitPackage,
} from '@/modules/marketplace/contract';
import type { MarketplacePackage } from '@/modules/marketplace/contract';
import { registerExtensionManifest } from '@/modules/extensions/contract';
import {
  createRecruitmentProposal,
  requestRecruitmentApproval,
  settleRecruitmentProposal,
} from '@/modules/agent-recruitment/contract';
import type { AgentRecruitmentProposal } from '@/modules/agent-recruitment/contract';
import { registerCapability, reviseCapability } from '@/modules/capabilities/contract';
import { authorizeAction, decideApproval, getActionRequest } from '@/modules/actions/contract';
import type { ActionRequest } from '@/modules/actions/contract';
import {
  defineOutcome,
  recordMeasurement,
  settleOutcome,
} from '@/modules/learning/contract';
import type { Outcome } from '@/modules/learning/contract';

// Deterministic service-clock pins (the injectable clock discipline —
// same-millisecond writes must not decide what a proof shows).
const T_GAP_1 = '2026-10-08T11:00:00.000Z';
const T_GAP_2 = '2026-10-08T11:10:00.000Z';
const T_GAP_3 = '2026-10-08T11:20:00.000Z';
const T_PROPOSAL = '2026-10-08T11:30:00.000Z';
const T_SUBMIT = '2026-10-08T11:40:00.000Z';
const T_REVIEW = '2026-10-08T11:50:00.000Z';
const T_PUBLISH = '2026-10-08T12:00:00.000Z';
const T_ACTIVATE = '2026-10-08T12:10:00.000Z';

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
  code: EmergentRolesErrorCode,
  fn: () => Promise<unknown>,
): Promise<EmergentRolesError> {
  try {
    await fn();
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(EmergentRolesError);
    const typed = error as EmergentRolesError;
    expect(typed.code).toBe(code);
    return typed;
  }
}

// ---------------------------------------------------------------------------
// Fixture factories (all content caller-supplied — no matching semantics
// live in these helpers, only the exact strings the fixtures declare)
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
    actor: { kind: 'system' as const, label: 'w138-test' },
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

/** A single-tenant-agent crew (the org-lab solo composition). */
function soloComposition() {
  return {
    nodes: [{ nodeId: 'solo', kind: 'tenant-agent' as const, role: 'Solo operator' }],
  };
}

/**
 * One OPEN learning outcome whose expected value is 10 (at_least) — a
 * measurement below settles it MISSED, at/above settles it MET/EXCEEDED.
 */
async function openOutcome(ctx: TenantContext, metricName: string): Promise<Outcome> {
  return defineOutcome(ctx, {
    subject: { kind: 'recommendation', id: newId(), label: 'w138 probe recommendation' },
    metricName,
    metricUnit: 'count',
    direction: 'at_least',
    baseline: 0,
    expected: 10,
    horizon: null,
    affectedGoals: [],
    originExecutionId: null,
    actor: { kind: 'person', label: 'ops lead' },
    rationale: 'the w138 commitment',
  });
}

/** Settles an outcome with one measurement — the assessment is derived. */
async function settleOutcomeAt(
  ctx: TenantContext,
  outcome: Outcome,
  value: number,
): Promise<Outcome> {
  const measurement = await recordMeasurement(ctx, {
    outcomeId: outcome.id,
    value,
    actor: { kind: 'system', label: 'metrics-warehouse' },
  });
  await settleOutcome(ctx, {
    outcomeId: outcome.id,
    measurementId: measurement.id,
    actor: { kind: 'person', label: 'ops lead' },
  });
  return outcome;
}

/** One org-lab recommendation over a goal, expecting the given outcome. */
async function recommendationExpecting(
  ctx: TenantContext,
  goal: Goal,
  fingerprintId: string,
  expectedOutcomeId: string,
): Promise<OrgRecommendation> {
  const candA = await registerCandidate(ctx, {
    slug: `a-${newId().slice(0, 8)}`,
    label: 'Solo crew',
    composition: soloComposition(),
  });
  const candB = await registerCandidate(ctx, {
    slug: `b-${newId().slice(0, 8)}`,
    label: 'Alternative crew',
    composition: soloComposition(),
  });
  return recordRecommendation(ctx, {
    goalId: goal.id,
    fingerprintId,
    knowledgeObjective: 'An organization that executes the survey program',
    evaluationConfig: { criteria: [{ name: 'fit', weight: 1 }] },
    candidates: [
      { candidateId: candA.id, disposition: 'recommended', summary: 'Fits the observed context.' },
      {
        candidateId: candB.id,
        disposition: 'rejected',
        summary: 'Weaker fit.',
        rejectionReasons: ['no survey capability'],
      },
    ],
    expectedOutcomeIds: [expectedOutcomeId],
  });
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

/** Walks a submitted package through the governed chain to INSTALLABLE. */
async function toInstallable(
  pkg: MarketplacePackage,
  platform: TenantContext,
): Promise<MarketplacePackage> {
  await runAutomatedVerification(platform, { packageId: pkg.id });
  await reviewPackage(platform, { packageId: pkg.id, decision: 'approve', reason: 'Clean artifact' });
  await publishPackage(platform, { packageId: pkg.id });
  return makePackageInstallable(platform, { packageId: pkg.id });
}

/** Creates + APPROVES one recruitment proposal (the real W022 path). */
async function approvedRecruitmentProposal(
  ctx: TenantContext,
  capabilityId: string,
): Promise<AgentRecruitmentProposal> {
  const proposal = await createRecruitmentProposal(ctx, {
    title: 'Close the recurring gap',
    capabilityId,
    rationale: 'The gap recurs across seasons.',
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

/** One W009 action request, decided (or left pending), re-read terminal. */
async function actionRequest(
  ctx: TenantContext,
  what: string,
  decision: 'approve' | 'reject' | 'leave-pending',
): Promise<ActionRequest> {
  const request = await authorizeAction(ctx, {
    actionKind: 'role-proposal-review',
    // EXECUTE is the built-in default's approval-gated level — the only
    // level that mints a PENDING request under the default matrix (a
    // lower level self-approves at authorization time).
    authorityLevel: 'EXECUTE',
    payload: { what },
    justification: `the w138 review of ${what}`,
  });
  if (decision === 'leave-pending') return request;
  const approverCtx: TenantContext = {
    tenantId: ctx.tenantId,
    principalId: newId(),
    authority: ['actions:approve'],
  };
  await decideApproval(approverCtx, { requestId: request.id, decision });
  return getActionRequest(ctx, { requestId: request.id });
}

/** The evidence-backed proposal input over the given real citations. */
function proposalInput(
  citations: string[],
  capabilityId: string,
  origin: { kind: 'org-lab' | 'tenant-operator'; recommendationId?: string | null } = {
    kind: 'tenant-operator',
  },
) {
  return {
    slug: `surveyor-${newId().slice(0, 8)}`,
    title: 'Site Surveyor',
    origin,
    evidenceCitationIds: citations,
    demands: [{ capabilityId, minimumLevel: 0.8 }],
    alternatives: [
      {
        label: 'Train an employee',
        description: 'Six-week training program.',
        evaluation: 'Too slow for the recurring spring window.',
      },
      {
        label: 'Hire a human surveyor',
        evaluation: 'Cost exceeds the budget envelope for the gap size.',
      },
    ],
    evaluation: {
      rationale: 'A specialist surveyor role closes the observed gap directly.',
      whyNow: 'The gap recurred across two consecutive seasons.',
      gapRecurrence: 'The site-survey capability missed expectations repeatedly.',
    },
  };
}

// ---------------------------------------------------------------------------
// Tenants (dedicated per concern so count/order assertions stay deterministic)
// ---------------------------------------------------------------------------

const tenantGov = newId();
const tenantErr = newId();
const tenantIsoA = newId();
const tenantIsoB = newId();
const tenantVendor = newId();
const tenantPlatform = newId();

// The Lab's recording principal (FIXED — the self-publish/self-activate
// refusals key on it) and the governed authority above the Lab.
const labPrincipalId = newId();
const authorityPrincipalId = newId();

// The failing agent's id, read by the transport branch at dispatch time
// (assigned inside beforeAll, before any execution is dispatched).
let agentFailFixtureId = '';

// --- tenantGov: the governed emergence (all acceptance clauses) ---
let goalGov: Goal;
let fingerprintGovId: string;
let capabilityGov: string;
let outcomeMissed: Outcome;
let outcomeMet: Outcome;
let outcomeOpen: Outcome;
let recommendationNegative: OrgRecommendation;
let recommendationPositive: OrgRecommendation;
let recommendationUncalibrated: OrgRecommendation;
let planGov: ExecutionPlan;
let runSucceeded: ExecutionRun;
let runFailed: ExecutionRun;
let requestApproved: ActionRequest;
let requestRejected: ActionRequest;
let requestPending: ActionRequest;
let recruitmentApproved: AgentRecruitmentProposal;
let recruitmentPending: AgentRecruitmentProposal;
let pkgInstallable: MarketplacePackage;
let pkgInvisible: MarketplacePackage;
let pkgExtension: MarketplacePackage;

// The recorded gap-evidence + proposal spine of tenantGov.
let gapOutcomeId: string;
let gapRecommendationId: string;
let gapRunId: string;
let labProposalId: string;
let govProposalId: string;

// --- tenantIsoA / tenantIsoB: tenant isolation ---
let proposalIsoA: string;
let gapIsoA: string;
let capabilityIsoB: string;

beforeAll(async () => {
  await runMigrations(getDb());

  // The in-process fake transport (the sanctioned W021 wiring seam): the
  // failing agent's dispatches are REFUSED by the runtime (a permanent
  // rejection → the execution settles terminal 'failed'); every other
  // agent delivers the openai-assistants dialect the module's own adapter
  // normalizes. No real provider is contacted.
  const fakeTransport: AgentRuntimeTransport = {
    send: async (request) => {
      if (request.agentId === agentFailFixtureId) {
        return {
          status: 'rejected' as const,
          payload: null,
          providerTaskId: null,
          detail: 'no capacity in the fixture runtime',
        };
      }
      return {
        status: 'delivered' as const,
        payload: {
          id: 'run_w138_fixture',
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
        providerTaskId: 'run_w138_fixture',
        detail: null,
      };
    },
  };
  setAgentTransport(fakeTransport);

  // ------------------------------------------------------------------
  // tenantGov — the governed emergence fixtures.
  // ------------------------------------------------------------------
  const gov = member(tenantGov);
  const govAdmin = member(tenantGov, newId(), ['agents:administer']);
  goalGov = await createGoal(gov, goalInput('Execute the spring site program'));
  const fingerprintGov = await deriveFingerprint(gov, {
    goalId: goalGov.id,
    task: { title: 'site program', kind: 'operations' },
    observations: springObservations(),
    derivedFrom: ['obs-gov-1'],
  });
  fingerprintGovId = fingerprintGov.fingerprintId;

  const actor = { kind: 'person' as const, id: 'fixture-actor' };
  const capability = await registerCapability(gov, { name: 'site-survey-execution', actor });
  capabilityGov = capability.id;

  // The W040 signals: one settled MISSED, one settled MET, one OPEN.
  outcomeMissed = await openOutcome(gov, 'surveys-completed');
  await settleOutcomeAt(gov, outcomeMissed, 4); // 4 < 10 at_least → missed
  outcomeMet = await openOutcome(gov, 'surveys-met');
  await settleOutcomeAt(gov, outcomeMet, 10); // 10 >= 10 → met
  outcomeOpen = await openOutcome(gov, 'surveys-open');

  // The W135 signals: one NEGATIVELY-calibrated recommendation (its
  // expected outcome settled missed, then the REAL calibration loop),
  // one POSITIVELY-calibrated, one uncalibrated.
  const negOutcome = await openOutcome(gov, 'neg-rec-outcome');
  recommendationNegative = await recommendationExpecting(
    gov,
    goalGov,
    fingerprintGovId,
    negOutcome.id,
  );
  await settleOutcomeAt(gov, negOutcome, 3); // missed
  await recordCalibration(gov, { recommendationId: recommendationNegative.id });
  const posOutcome = await openOutcome(gov, 'pos-rec-outcome');
  recommendationPositive = await recommendationExpecting(
    gov,
    goalGov,
    fingerprintGovId,
    posOutcome.id,
  );
  await settleOutcomeAt(gov, posOutcome, 12); // exceeded
  await recordCalibration(gov, { recommendationId: recommendationPositive.id });
  const uncalOutcome = await openOutcome(gov, 'uncal-rec-outcome');
  recommendationUncalibrated = await recommendationExpecting(
    gov,
    goalGov,
    fingerprintGovId,
    uncalOutcome.id,
  );

  // The W136 signal: a REAL plan + one FAILED run and one SUCCEEDED run.
  const agentLead = await registerTenantAgent(govAdmin, 'w138-lead-specialist');
  const agentFail = await registerTenantAgent(govAdmin, 'w138-fail-specialist');
  agentFailFixtureId = agentFail.id;
  const executionSucceeded = await submitAgentExecution(gov, {
    agentId: agentLead.id,
    task: { instruction: 'Survey the site', context: 'spring window' },
    requestedPermissions: ['observe'],
  });
  const succeededExecution = await runAgentExecution(gov, { executionId: executionSucceeded.id });
  expect(succeededExecution.status).toBe('succeeded'); // fixture invariant
  const executionFailed = await submitAgentExecution(gov, {
    agentId: agentFail.id,
    task: { instruction: 'Survey the site', context: 'spring window' },
    requestedPermissions: ['observe'],
  });
  const failedExecution = await runAgentExecution(gov, { executionId: executionFailed.id });
  expect(failedExecution.status).toBe('failed'); // fixture invariant
  planGov = await exchangeContract.createExecutionPlan(gov, {
    goalId: goalGov.id,
    fingerprintId: fingerprintGovId,
    objective: 'Execute the survey program',
    tasks: [
      { taskKey: 'survey', title: 'Survey the site' },
      { taskKey: 'dispatch', title: 'Dispatch crews', dependsOn: ['survey'] },
    ],
    members: [
      { memberKey: 'lead', kind: 'tenant-agent', role: 'Lead specialist', ref: agentLead.id },
    ],
  });
  runSucceeded = await exchangeContract.recordExecutionRun(gov, {
    planId: planGov.id,
    taskKey: 'survey',
    agentExecutionId: executionSucceeded.id,
  });
  runFailed = await exchangeContract.recordExecutionRun(gov, {
    planId: planGov.id,
    taskKey: 'dispatch',
    agentExecutionId: executionFailed.id,
  });

  // The W009 decisions: approved, rejected, one left pending.
  requestApproved = await actionRequest(gov, 'the spring surveyor proposal', 'approve');
  requestRejected = await actionRequest(gov, 'a rejected variant', 'reject');
  requestPending = await actionRequest(gov, 'a still-pending variant', 'leave-pending');

  // The W022 acquisitions: one APPROVED, one still awaiting approval.
  recruitmentApproved = await approvedRecruitmentProposal(gov, capabilityGov);
  const pendingProposal = await createRecruitmentProposal(gov, {
    title: 'A pending acquisition',
    capabilityId: capabilityGov,
    rationale: 'Not yet decided.',
    evidenceObservationIds: ['00000000-0000-4000-8000-0000000000e2'],
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
  recruitmentPending = await requestRecruitmentApproval(gov, {
    proposalId: pendingProposal.id,
    justification: 'awaiting the authority decision',
  });

  // The marketplace chain (the governed W028 path): a vendor agent
  // package walked to INSTALLABLE, a still-invisible one, and a
  // PUBLISHED extension package (the kind-mismatch probe).
  const vendor = member(tenantVendor, newId(), ['marketplace:submit', 'extensions:administer']);
  const platform = member(tenantPlatform, newId(), ['marketplace:administer']);
  pkgInstallable = await toInstallable(
    await submittedAgentPackage(vendor, 'w138-site-surveyor', '1.0.0'),
    platform,
  );
  pkgInvisible = await submittedAgentPackage(vendor, 'w138-invisible-draft', '0.1.0');
  const manifest = await registerExtensionManifest(vendor, {
    extensionKey: 'w138-invoice-sync',
    version: '1.4.0',
    manifestSchemaVersion: 1,
    displayName: 'Invoice Sync',
    hostRuntime: { minVersion: '1.0.0' },
  });
  const extensionPackage = await createPackage(vendor, {
    kind: 'extension',
    manifestId: manifest.manifest.id,
  });
  const extensionSubmitted = await submitPackage(vendor, { packageId: extensionPackage.id });
  await runAutomatedVerification(platform, { packageId: extensionSubmitted.id });
  const extensionReviewed = await reviewPackage(platform, {
    packageId: extensionSubmitted.id,
    decision: 'approve',
    reason: 'Clean',
  });
  pkgExtension = await publishPackage(platform, { packageId: extensionReviewed.package.id });

  // ------------------------------------------------------------------
  // tenantIsoA / tenantIsoB — the isolation fixtures (same slug, same
  // shape, fully independent state).
  // ------------------------------------------------------------------
  const isoA = member(tenantIsoA);
  const isoB = member(tenantIsoB);
  const capA = await registerCapability(isoA, { name: 'iso-survey', actor });
  const capB = await registerCapability(isoB, { name: 'iso-survey', actor });
  capabilityIsoB = capB.id;
  const outcomeA1 = await settleOutcomeAt(isoA, await openOutcome(isoA, 'iso-a-1'), 4);
  const outcomeA2 = await settleOutcomeAt(isoA, await openOutcome(isoA, 'iso-a-2'), 5);
  const outcomeB1 = await settleOutcomeAt(isoB, await openOutcome(isoB, 'iso-b-1'), 6);
  const outcomeB2 = await settleOutcomeAt(isoB, await openOutcome(isoB, 'iso-b-2'), 7);
  const gapA1 = await emergent.recordGapEvidence(isoA, {
    capabilityId: capA.id,
    source: { kind: 'learning-outcome', outcomeId: outcomeA1.id },
    observation: 'The first missed window.',
  });
  const gapA2 = await emergent.recordGapEvidence(isoA, {
    capabilityId: capA.id,
    source: { kind: 'learning-outcome', outcomeId: outcomeA2.id },
    observation: 'The second missed window.',
  });
  gapIsoA = gapA1.id;
  const gapB1 = await emergent.recordGapEvidence(isoB, {
    capabilityId: capB.id,
    source: { kind: 'learning-outcome', outcomeId: outcomeB1.id },
    observation: 'The first missed window.',
  });
  const gapB2 = await emergent.recordGapEvidence(isoB, {
    capabilityId: capB.id,
    source: { kind: 'learning-outcome', outcomeId: outcomeB2.id },
    observation: 'The second missed window.',
  });
  const sharedSlug = 'iso-surveyor-role';
  const proposalA = await emergent.createRoleProposal(isoA, {
    ...proposalInput([gapA1.id, gapA2.id], capA.id),
    slug: sharedSlug,
  });
  await emergent.createRoleProposal(isoB, {
    ...proposalInput([gapB1.id, gapB2.id], capB.id),
    slug: sharedSlug,
  });
  proposalIsoA = proposalA.id;
}, 300_000);

afterAll(async () => {
  await closeDb();
});

// ---------------------------------------------------------------------------
// recordGapEvidence — the three evidence seams (the evidence authority rule)
// ---------------------------------------------------------------------------

describe('recordGapEvidence — real cross-seam evidence aggregation', () => {
  it('records gap evidence from a REAL settled-MISSED W040 outcome, verbatim', async () => {
    const gov = member(tenantGov);
    const unpin = pinClock(T_GAP_1);
    let recorded;
    try {
      recorded = await emergent.recordGapEvidence(gov, {
        capabilityId: capabilityGov,
        source: { kind: 'learning-outcome', outcomeId: outcomeMissed.id },
        observation: 'The spring window missed its survey-completion target.',
      });
    } finally {
      unpin();
    }
    gapOutcomeId = recorded.id;
    expect(recorded.tenantId).toBe(tenantGov);
    expect(recorded.capabilityId).toBe(capabilityGov);
    expect(recorded.source).toEqual({ kind: 'learning-outcome', outcomeId: outcomeMissed.id });
    expect(recorded.observation).toBe('The spring window missed its survey-completion target.');
    expect(recorded.recordedBy).toBe(gov.principalId); // system-captured
    expect(recorded.recordedAt).toBe(T_GAP_1); // service clock
    const reread = await emergent.getGapEvidence(gov, { gapEvidenceId: recorded.id });
    expect(reread).toEqual(recorded);
  });

  it('records gap evidence from a REAL NEGATIVELY-calibrated W135 recommendation', async () => {
    const lab = member(tenantGov, labPrincipalId);
    const unpin = pinClock(T_GAP_2);
    let recorded;
    try {
      recorded = await emergent.recordGapEvidence(lab, {
        capabilityId: capabilityGov,
        source: { kind: 'org-lab-recommendation', recommendationId: recommendationNegative.id },
        observation: "The Lab's recommended organization failed its expected outcome.",
      });
    } finally {
      unpin();
    }
    gapRecommendationId = recorded.id;
    expect(recorded.source).toEqual({
      kind: 'org-lab-recommendation',
      recommendationId: recommendationNegative.id,
    });
    expect(recorded.recordedBy).toBe(labPrincipalId);
    expect(recorded.recordedAt).toBe(T_GAP_2);
  });

  it('records gap evidence from a REAL FAILED W136 execution run', async () => {
    const gov = member(tenantGov);
    const unpin = pinClock(T_GAP_3);
    let recorded;
    try {
      recorded = await emergent.recordGapEvidence(gov, {
        capabilityId: capabilityGov,
        source: { kind: 'execution-run', planId: planGov.id, runId: runFailed.id },
        observation: 'The dispatch task failed its execution twice this season.',
      });
    } finally {
      unpin();
    }
    gapRunId = recorded.id;
    expect(recorded.source).toEqual({
      kind: 'execution-run',
      planId: planGov.id,
      runId: runFailed.id,
    });
    expect(recorded.recordedAt).toBe(T_GAP_3);
  });

  it('refuses non-signals with their typed codes (no prediction, no positivity)', async () => {
    const gov = member(tenantGov);
    await expectCode('outcome_not_gap_evidence', () =>
      emergent.recordGapEvidence(gov, {
        capabilityId: capabilityGov,
        source: { kind: 'learning-outcome', outcomeId: outcomeOpen.id },
        observation: 'An open outcome is not a gap signal.',
      }),
    );
    await expectCode('outcome_not_gap_evidence', () =>
      emergent.recordGapEvidence(gov, {
        capabilityId: capabilityGov,
        source: { kind: 'learning-outcome', outcomeId: outcomeMet.id },
        observation: 'A met outcome is not a gap signal.',
      }),
    );
    await expectCode('recommendation_not_gap_evidence', () =>
      emergent.recordGapEvidence(gov, {
        capabilityId: capabilityGov,
        source: { kind: 'org-lab-recommendation', recommendationId: recommendationUncalibrated.id },
        observation: 'An uncalibrated recommendation is not a gap signal.',
      }),
    );
    await expectCode('recommendation_not_gap_evidence', () =>
      emergent.recordGapEvidence(gov, {
        capabilityId: capabilityGov,
        source: { kind: 'org-lab-recommendation', recommendationId: recommendationPositive.id },
        observation: 'A positively-calibrated recommendation is not a gap signal.',
      }),
    );
    await expectCode('run_not_gap_evidence', () =>
      emergent.recordGapEvidence(gov, {
        capabilityId: capabilityGov,
        source: { kind: 'execution-run', planId: planGov.id, runId: runSucceeded.id },
        observation: 'A succeeded run is not a gap signal.',
      }),
    );
  });

  it('reads foreign/missing/retired references uniformly as typed not-founds', async () => {
    const gov = member(tenantGov);
    await expectCode('outcome_ref_not_found', () =>
      emergent.recordGapEvidence(gov, {
        capabilityId: capabilityGov,
        source: { kind: 'learning-outcome', outcomeId: newId() },
        observation: 'A missing outcome.',
      }),
    );
    await expectCode('plan_ref_not_found', () =>
      emergent.recordGapEvidence(gov, {
        capabilityId: capabilityGov,
        source: { kind: 'execution-run', planId: newId(), runId: runFailed.id },
        observation: 'A missing plan.',
      }),
    );
    await expectCode('run_ref_not_found', () =>
      emergent.recordGapEvidence(gov, {
        capabilityId: capabilityGov,
        source: { kind: 'execution-run', planId: planGov.id, runId: newId() },
        observation: 'A run not recorded on the plan.',
      }),
    );
    await expectCode('recommendation_ref_not_found', () =>
      emergent.recordGapEvidence(gov, {
        capabilityId: capabilityGov,
        source: { kind: 'org-lab-recommendation', recommendationId: newId() },
        observation: 'A missing recommendation.',
      }),
    );
    // A retired capability reads uniformly as not-found (a live proposal
    // demands live graph nodes).
    const errer = member(tenantErr);
    const actor = { kind: 'person' as const, id: 'fixture-actor' };
    const retired = await registerCapability(errer, { name: 'retired-survey', actor });
    await reviseCapability(errer, {
      capabilityId: retired.id,
      status: 'retired',
      actor,
      rationale: 'no longer offered',
    });
    const errOutcome = await settleOutcomeAt(errer, await openOutcome(errer, 'err-outcome'), 4);
    await expectCode('capability_ref_not_found', () =>
      emergent.recordGapEvidence(errer, {
        capabilityId: retired.id,
        source: { kind: 'learning-outcome', outcomeId: errOutcome.id },
        observation: 'The capability is retired.',
      }),
    );
    // A foreign capability is indistinguishable from a missing one.
    await expectCode('capability_ref_not_found', () =>
      emergent.recordGapEvidence(gov, {
        capabilityId: retired.id,
        source: { kind: 'learning-outcome', outcomeId: outcomeMissed.id },
        observation: 'A foreign capability.',
      }),
    );
  });

  it('enforces ONE UPSTREAM RECORD = ONE GAP (honest recurrence counting)', async () => {
    const gov = member(tenantGov);
    await expectCode('gap_source_already_cited', () =>
      emergent.recordGapEvidence(gov, {
        capabilityId: capabilityGov,
        source: { kind: 'learning-outcome', outcomeId: outcomeMissed.id },
        observation: 'The same miss cannot pose as two gaps.',
      }),
    );
    await expectCode('gap_source_already_cited', () =>
      emergent.recordGapEvidence(gov, {
        capabilityId: capabilityGov,
        source: { kind: 'org-lab-recommendation', recommendationId: recommendationNegative.id },
        observation: 'The same failed recommendation cannot pose as two gaps.',
      }),
    );
    await expectCode('gap_source_already_cited', () =>
      emergent.recordGapEvidence(gov, {
        capabilityId: capabilityGov,
        source: { kind: 'execution-run', planId: planGov.id, runId: runFailed.id },
        observation: 'The same failed run cannot pose as two gaps.',
      }),
    );
  });

  it('keeps gap evidence append-only at the storage level', async () => {
    const db = getDb();
    await expect(
      db.query(`UPDATE role_gap_evidence SET observation = 'forged'`),
    ).rejects.toThrow(/append-only/);
    await expect(db.query(`DELETE FROM role_gap_evidence`)).rejects.toThrow(/append-only/);
    await expect(db.query(`TRUNCATE role_gap_evidence`)).rejects.toThrow(/append-only/);
  });
});

// ---------------------------------------------------------------------------
// createRoleProposal — acceptance clause 1
// ---------------------------------------------------------------------------

describe('createRoleProposal — the evidence-backed case (acceptance clause 1)', () => {
  it('creates a draft carrying the WHOLE frozen case over real citations', async () => {
    const gov = member(tenantGov);
    const unpin = pinClock(T_PROPOSAL);
    let proposal;
    try {
      proposal = await emergent.createRoleProposal(gov, {
        ...proposalInput([gapOutcomeId, gapRecommendationId, gapRunId], capabilityGov),
        slug: 'site-surveyor-role',
        title: 'Site Surveyor',
        note: 'Emerged from the spring recurrence.',
      });
    } finally {
      unpin();
    }
    govProposalId = proposal.id;
    expect(proposal.tenantId).toBe(tenantGov);
    expect(proposal.slug).toBe('site-surveyor-role');
    expect(proposal.status).toBe('draft');
    expect(proposal.origin).toEqual({
      kind: 'tenant-operator',
      recommendationId: null,
      principalId: gov.principalId,
    });
    // Evidence: all three real citations, verbatim.
    expect(proposal.evidenceCitationIds).toEqual([gapOutcomeId, gapRecommendationId, gapRunId]);
    // Capability demands: typed against the W017 proficiency semantics.
    expect(proposal.demands).toEqual([
      { capabilityId: capabilityGov, minimumLevel: 0.8, note: null },
    ]);
    // Alternatives: each with its retained evaluation.
    expect(proposal.alternatives).toEqual([
      {
        label: 'Train an employee',
        description: 'Six-week training program.',
        evaluation: 'Too slow for the recurring spring window.',
      },
      {
        label: 'Hire a human surveyor',
        description: null,
        evaluation: 'Cost exceeds the budget envelope for the gap size.',
      },
    ]);
    // The structured evaluation summary.
    expect(proposal.evaluation).toEqual({
      rationale: 'A specialist surveyor role closes the observed gap directly.',
      whyNow: 'The gap recurred across two consecutive seasons.',
      gapRecurrence: 'The site-survey capability missed expectations repeatedly.',
    });
    expect(proposal.note).toBe('Emerged from the spring recurrence.');
    expect(proposal.createdBy).toBe(gov.principalId); // system-captured
    expect(proposal.createdAt).toBe(T_PROPOSAL);
    expect(proposal.submittedAt).toBeNull();
    expect(proposal.decidedAt).toBeNull();
    expect(proposal.fulfilledAt).toBeNull();
    expect(proposal.withdrawnAt).toBeNull();
  });

  it('creates the LAB-origin proposal against a REAL W135 recommendation', async () => {
    const lab = member(tenantGov, labPrincipalId);
    const proposal = await emergent.createRoleProposal(lab, {
      ...proposalInput(
        [gapOutcomeId, gapRecommendationId, gapRunId],
        capabilityGov,
        { kind: 'org-lab', recommendationId: recommendationNegative.id },
      ),
      slug: 'lab-site-surveyor-role',
      title: 'Lab Site Surveyor',
    });
    labProposalId = proposal.id;
    expect(proposal.origin).toEqual({
      kind: 'org-lab',
      recommendationId: recommendationNegative.id,
      principalId: labPrincipalId,
    });
  });

  it('refuses citations about capabilities the proposal does not demand', async () => {
    const gov = member(tenantGov);
    const otherCapability = await registerCapability(gov, {
      name: 'unrelated-capability',
      actor: { kind: 'person', id: 'fixture-actor' },
    });
    await expectCode('citation_demand_mismatch', () =>
      emergent.createRoleProposal(gov, {
        ...proposalInput([gapOutcomeId, gapRecommendationId], otherCapability.id),
      }),
    );
  });

  it('refuses missing/foreign citations and taken slugs uniformly', async () => {
    const gov = member(tenantGov);
    await expectCode('gap_evidence_not_found', () =>
      emergent.createRoleProposal(gov, {
        ...proposalInput([gapOutcomeId, newId()], capabilityGov),
      }),
    );
    await expectCode('gap_evidence_not_found', () =>
      emergent.createRoleProposal(gov, {
        ...proposalInput([gapIsoA, gapOutcomeId], capabilityGov), // foreign-tenant gap
      }),
    );
    await expectCode('slug_taken', () =>
      emergent.createRoleProposal(gov, {
        ...proposalInput([gapOutcomeId, gapRecommendationId], capabilityGov),
        slug: 'site-surveyor-role',
      }),
    );
    await expectCode('recommendation_ref_not_found', () =>
      emergent.createRoleProposal(gov, {
        ...proposalInput([gapOutcomeId, gapRecommendationId], capabilityGov, {
          kind: 'org-lab',
          recommendationId: newId(),
        }),
      }),
    );
  });

  it('keeps proposal content immutable and rows durable at the storage level', async () => {
    const db = getDb();
    await expect(
      db.query(
        `UPDATE role_proposals SET demands = '[{"capabilityId":"00000000-0000-4000-8000-0000000000ff","minimumLevel":0.1,"note":null}]'::jsonb WHERE id = $1`,
        [govProposalId],
      ),
    ).rejects.toThrow(/immutable/);
    await expect(
      db.query(`UPDATE role_proposals SET title = 'forged' WHERE id = $1`, [govProposalId]),
    ).rejects.toThrow(/immutable/);
    await expect(
      db.query(`DELETE FROM role_proposals WHERE id = $1`, [govProposalId]),
    ).rejects.toThrow(/lifecycle-managed/);
    await expect(db.query(`TRUNCATE role_proposals`)).rejects.toThrow(/lifecycle-managed/);
  });
});

// ---------------------------------------------------------------------------
// The one-way lifecycle (submit / withdraw / review)
// ---------------------------------------------------------------------------

describe('the one-way proposal lifecycle', () => {
  it('submits a draft → under_review, stamping submitted_at/by exactly once', async () => {
    const gov = member(tenantGov);
    const unpin = pinClock(T_SUBMIT);
    let submitted;
    try {
      submitted = await emergent.submitRoleProposal(gov, { proposalId: labProposalId });
    } finally {
      unpin();
    }
    expect(submitted.status).toBe('under_review');
    expect(submitted.submittedAt).toBe(T_SUBMIT);
    expect(submitted.submittedBy).toBe(gov.principalId);
    expect(submitted.decidedAt).toBeNull();
  });

  it('refuses re-submission — the lifecycle is one-way (staleness posture)', async () => {
    const gov = member(tenantGov);
    await expectCode('proposal_not_submittable', () =>
      emergent.submitRoleProposal(gov, { proposalId: labProposalId }),
    );
    await expectCode('proposal_not_found', () =>
      emergent.submitRoleProposal(gov, { proposalId: newId() }),
    );
  });

  it('withdraws from draft with the retained reason (terminal)', async () => {
    const gov = member(tenantGov);
    const proposal = await emergent.createRoleProposal(gov, {
      ...proposalInput([gapOutcomeId, gapRecommendationId], capabilityGov),
      slug: 'withdrawn-surveyor-role',
    });
    const withdrawn = await emergent.withdrawRoleProposal(gov, {
      proposalId: proposal.id,
      reason: 'Superseded by the lab proposal.',
    });
    expect(withdrawn.status).toBe('withdrawn');
    expect(withdrawn.withdrawnAt).not.toBeNull();
    expect(withdrawn.lifecycleNote).toBe('Superseded by the lab proposal.');
    // Terminal: nothing further moves.
    await expectCode('proposal_not_withdrawable', () =>
      emergent.withdrawRoleProposal(gov, { proposalId: proposal.id, reason: 'Again.' }),
    );
    await expectCode('proposal_not_submittable', () =>
      emergent.submitRoleProposal(gov, { proposalId: proposal.id }),
    );
  });

  it('refuses a review against a non-reviewed proposal and a pending request', async () => {
    const gov = member(tenantGov);
    // The draft proposal is not under review.
    await expectCode('proposal_not_under_review', () =>
      emergent.recordProposalReview(gov, {
        proposalId: govProposalId,
        actionRequestId: requestApproved.id,
      }),
    );
    // The lab proposal is under review, but the request is still pending.
    await expectCode('review_not_decided', () =>
      emergent.recordProposalReview(gov, {
        proposalId: labProposalId,
        actionRequestId: requestPending.id,
      }),
    );
    // A foreign action request is uniformly not-found.
    await expectCode('review_request_not_found', () =>
      emergent.recordProposalReview(gov, {
        proposalId: labProposalId,
        actionRequestId: newId(),
      }),
    );
  });

  it('records the APPROVED review — the W009 decision snapshot VERBATIM', async () => {
    const gov = member(tenantGov);
    const unpin = pinClock(T_REVIEW);
    let review;
    try {
      review = await emergent.recordProposalReview(gov, {
        proposalId: labProposalId,
        actionRequestId: requestApproved.id,
      });
    } finally {
      unpin();
    }
    expect(review.proposalId).toBe(labProposalId);
    expect(review.recordedBy).toBe(gov.principalId);
    expect(review.recordedAt).toBe(T_REVIEW);
    // The frozen snapshot is the actions module's own values — no
    // transformation, no re-derivation.
    expect(review.decision).toEqual({
      actionRequestId: requestApproved.id,
      actionKind: requestApproved.actionKind,
      authorityLevel: requestApproved.authorityLevel,
      status: 'approved',
      requestedBy: requestApproved.requestedBy,
      requestedAt: requestApproved.requestedAt,
      decidedAt: requestApproved.decidedAt,
    });
    const proposal = await emergent.getRoleProposal(gov, { proposalId: labProposalId });
    expect(proposal.status).toBe('approved');
    expect(proposal.decidedAt).toBe(T_REVIEW);
    expect(proposal.fulfilledAt).toBeNull();
  });

  it('records a REJECTED review as retained evidence (the second exit)', async () => {
    const gov = member(tenantGov);
    const proposal = await emergent.createRoleProposal(gov, {
      ...proposalInput([gapOutcomeId, gapRecommendationId], capabilityGov),
      slug: 'rejected-surveyor-role',
    });
    await emergent.submitRoleProposal(gov, { proposalId: proposal.id });
    const review = await emergent.recordProposalReview(gov, {
      proposalId: proposal.id,
      actionRequestId: requestRejected.id,
    });
    expect(review.decision.status).toBe('rejected');
    const rejected = await emergent.getRoleProposal(gov, { proposalId: proposal.id });
    expect(rejected.status).toBe('rejected');
    expect(rejected.decidedAt).not.toBeNull();
    // A rejected proposal may not be withdrawn, submitted or activated.
    await expectCode('proposal_not_withdrawable', () =>
      emergent.withdrawRoleProposal(gov, { proposalId: proposal.id, reason: 'No.' }),
    );
    await expectCode('proposal_not_approved', () =>
      emergent.recordMarketplaceSubmission(gov, {
        proposalId: proposal.id,
        packageId: pkgInstallable.id,
      }),
    );
  });

  it('refuses a second review — one decision per proposal, ever', async () => {
    const gov = member(tenantGov);
    await expectCode('proposal_not_under_review', () =>
      emergent.recordProposalReview(gov, {
        proposalId: labProposalId,
        actionRequestId: requestApproved.id,
      }),
    );
  });

  it('keeps reviews append-only at the storage level', async () => {
    const db = getDb();
    await expect(
      db.query(`UPDATE role_proposal_reviews SET decision = '{"forged":true}'::jsonb`),
    ).rejects.toThrow(/append-only/);
    await expect(db.query(`DELETE FROM role_proposal_reviews`)).rejects.toThrow(/append-only/);
  });
});

// ---------------------------------------------------------------------------
// recordMarketplaceSubmission — acceptance clause 2 (publication governed)
// ---------------------------------------------------------------------------

describe('recordMarketplaceSubmission — the governed publication REQUEST', () => {
  it('THE LAB CANNOT SELF-PUBLISH — typed refusal for the recording principal', async () => {
    const lab = member(tenantGov, labPrincipalId);
    await expectCode('lab_cannot_self_publish', () =>
      emergent.recordMarketplaceSubmission(lab, {
        proposalId: labProposalId,
        packageId: pkgInstallable.id,
      }),
    );
  });

  it('records the submission against the package the governed chain produced, VERBATIM and UNMOVED', async () => {
    const authority = member(tenantGov, authorityPrincipalId);
    const unpin = pinClock(T_PUBLISH);
    let submission;
    try {
      submission = await emergent.recordMarketplaceSubmission(authority, {
        proposalId: labProposalId,
        packageId: pkgInstallable.id,
        note: 'Through the governed chain.',
      });
    } finally {
      unpin();
    }
    expect(submission.proposalId).toBe(labProposalId);
    expect(submission.packageId).toBe(pkgInstallable.id);
    // The frozen identity + state are the marketplace's own values.
    expect(submission.packageKey).toBe('w138-site-surveyor');
    expect(submission.packageVersion).toBe('1.0.0');
    expect(submission.packageState).toBe('INSTALLABLE');
    expect(submission.recordedBy).toBe(authorityPrincipalId); // system-captured
    expect(submission.recordedAt).toBe(T_PUBLISH);
    // Publication stays governed: the module advanced NOTHING — the
    // package is exactly where the marketplace chain left it.
    const after = await getPackage(authority, { packageId: pkgInstallable.id });
    expect(after.state).toBe('INSTALLABLE');
    expect(after.version).toBe('1.0.0');
    const reread = await emergent.listMarketplaceSubmissions(authority, {
      proposalId: labProposalId,
    });
    expect(reread).toEqual([submission]);
  });

  it('refuses unapproved proposals, invisible packages and non-agent kinds', async () => {
    const gov = member(tenantGov);
    // The tenant-operator proposal is still a draft.
    await expectCode('proposal_not_approved', () =>
      emergent.recordMarketplaceSubmission(gov, {
        proposalId: govProposalId,
        packageId: pkgInstallable.id,
      }),
    );
    // A package not visible to this tenant (foreign, pre-publication) is
    // uniformly not-found — the marketplace owns visibility.
    await expectCode('marketplace_ref_not_found', () =>
      emergent.recordMarketplaceSubmission(gov, {
        proposalId: labProposalId,
        packageId: pkgInvisible.id,
      }),
    );
    await expectCode('marketplace_ref_not_found', () =>
      emergent.recordMarketplaceSubmission(gov, {
        proposalId: labProposalId,
        packageId: newId(),
      }),
    );
    // A visible but non-agent package cannot carry a role proposal.
    await expectCode('marketplace_ref_not_agent_package', () =>
      emergent.recordMarketplaceSubmission(gov, {
        proposalId: labProposalId,
        packageId: pkgExtension.id,
      }),
    );
  });

  it('exports NO publication/install primitive — the surface tripwire', async () => {
    // The public surface of this module must never grow a marketplace-
    // mutating operation: publication belongs to W028, installation to
    // W028 + W022, activation to W022, decisions to W009.
    const forbidden = [
      'createPackage',
      'submitPackage',
      'publishPackage',
      'makePackageInstallable',
      'installPackage',
      'reviewPackage',
      'createRecruitmentProposal',
      'recruitAgent',
      'activatePackage',
      'decideApproval',
    ];
    for (const name of forbidden) {
      expect(
        (emergent as unknown as Record<string, unknown>)[name],
        `emergent-roles must not export '${name}'`,
      ).toBeUndefined();
    }
  });

  it('keeps submissions append-only AND Lab-separated at the storage level', async () => {
    const db = getDb();
    await expect(
      db.query(`UPDATE role_marketplace_submissions SET package_state = 'DRAFT'`),
    ).rejects.toThrow(/append-only/);
    await expect(
      db.query(`DELETE FROM role_marketplace_submissions`),
    ).rejects.toThrow(/append-only/);
    // The storage-level Lab separation: the bad row is unrepresentable
    // even for a caller bypassing the service entirely.
    await expect(
      db.query(
        `INSERT INTO role_marketplace_submissions
           (id, tenant_id, proposal_id, package_id, package_key, package_version,
            package_state, note, recorded_by, recorded_at)
         VALUES ($1, $2, $3, $4, 'forged', '9.9.9', 'PUBLISHED', null, $5, now())`,
        [newId(), tenantGov, labProposalId, pkgInstallable.id, labPrincipalId],
      ),
    ).rejects.toThrow(/Lab authority separation/);
  });
});

// ---------------------------------------------------------------------------
// recordRoleActivation — acceptance clauses 2 + 3
// ---------------------------------------------------------------------------

describe('recordRoleActivation — the governed acquisition RECORD', () => {
  it('THE LAB CANNOT SELF-ACTIVATE — typed refusal for the recording principal', async () => {
    const lab = member(tenantGov, labPrincipalId);
    await expectCode('lab_cannot_self_activate', () =>
      emergent.recordRoleActivation(lab, {
        proposalId: labProposalId,
        recruitmentProposalId: recruitmentApproved.id,
      }),
    );
  });

  it('records the activation against the APPROVED W022 acquisition, fulfilling the proposal once', async () => {
    const authority = member(tenantGov, authorityPrincipalId);
    const unpin = pinClock(T_ACTIVATE);
    let activation;
    try {
      activation = await emergent.recordRoleActivation(authority, {
        proposalId: labProposalId,
        recruitmentProposalId: recruitmentApproved.id,
        note: 'The specialist joined the crew.',
      });
    } finally {
      unpin();
    }
    expect(activation.proposalId).toBe(labProposalId);
    expect(activation.recruitmentProposalId).toBe(recruitmentApproved.id);
    expect(activation.recordedBy).toBe(authorityPrincipalId);
    expect(activation.recordedAt).toBe(T_ACTIVATE);
    const fulfilled = await emergent.getRoleProposal(authority, { proposalId: labProposalId });
    expect(fulfilled.status).toBe('fulfilled');
    expect(fulfilled.fulfilledAt).toBe(T_ACTIVATE);
    expect(fulfilled.decidedAt).toBe(T_REVIEW); // the review stamp survived
    const reread = await emergent.listRoleActivations(authority, { proposalId: labProposalId });
    expect(reread).toEqual([activation]);
  });

  it('refuses unapproved acquisitions and unapproved proposals, uniformly', async () => {
    const gov = member(tenantGov);
    // A second APPROVED proposal (its own governed review) isolates the
    // acquisition-side refusals from the proposal-side gate.
    const probe = await emergent.createRoleProposal(gov, {
      ...proposalInput([gapOutcomeId, gapRecommendationId], capabilityGov),
      slug: 'activation-probe-role',
    });
    await emergent.submitRoleProposal(gov, { proposalId: probe.id });
    const probeApproved = await actionRequest(gov, 'the activation probe', 'approve');
    await emergent.recordProposalReview(gov, {
      proposalId: probe.id,
      actionRequestId: probeApproved.id,
    });
    await expectCode('recruitment_not_approved', () =>
      emergent.recordRoleActivation(gov, {
        proposalId: probe.id,
        recruitmentProposalId: recruitmentPending.id,
      }),
    );
    await expectCode('recruitment_ref_not_found', () =>
      emergent.recordRoleActivation(gov, {
        proposalId: probe.id,
        recruitmentProposalId: newId(),
      }),
    );
    // govProposalId is still a draft — activation needs the APPROVED state.
    await expectCode('proposal_not_approved', () =>
      emergent.recordRoleActivation(gov, {
        proposalId: govProposalId,
        recruitmentProposalId: recruitmentApproved.id,
      }),
    );
  });

  it('the fulfilled lifecycle is terminal (staleness re-check posture)', async () => {
    const gov = member(tenantGov);
    await expectCode('proposal_not_approved', () =>
      emergent.recordRoleActivation(gov, {
        proposalId: labProposalId,
        recruitmentProposalId: recruitmentApproved.id,
      }),
    );
    await expectCode('proposal_not_submittable', () =>
      emergent.submitRoleProposal(gov, { proposalId: labProposalId }),
    );
    await expectCode('proposal_not_withdrawable', () =>
      emergent.withdrawRoleProposal(gov, { proposalId: labProposalId, reason: 'Too late.' }),
    );
    await expectCode('proposal_not_under_review', () =>
      emergent.recordProposalReview(gov, {
        proposalId: labProposalId,
        actionRequestId: requestApproved.id,
      }),
    );
  });

  it('keeps activations append-only AND Lab-separated at the storage level', async () => {
    const db = getDb();
    await expect(db.query(`UPDATE role_activations SET note = 'forged'`)).rejects.toThrow(
      /append-only/,
    );
    await expect(db.query(`DELETE FROM role_activations`)).rejects.toThrow(/append-only/);
    await expect(
      db.query(
        `INSERT INTO role_activations
           (id, tenant_id, proposal_id, recruitment_proposal_id, note,
            recorded_by, recorded_at)
         VALUES ($1, $2, $3, $4, null, $5, now())`,
        [newId(), tenantGov, labProposalId, recruitmentApproved.id, labPrincipalId],
      ),
    ).rejects.toThrow(/Lab authority separation/);
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation (ADR-0001)
// ---------------------------------------------------------------------------

describe('tenant isolation (ADR-0001)', () => {
  it('holds fully independent emergence state across two tenants', async () => {
    const isoA = member(tenantIsoA);
    const isoB = member(tenantIsoB);
    // The same slug coexists (per-tenant uniqueness only).
    const proposalsA = await emergent.listRoleProposals(isoA);
    const proposalsB = await emergent.listRoleProposals(isoB);
    expect(proposalsA).toHaveLength(1);
    expect(proposalsB).toHaveLength(1);
    expect(proposalsA[0]!.slug).toBe('iso-surveyor-role');
    expect(proposalsB[0]!.slug).toBe('iso-surveyor-role');
    expect(proposalsA[0]!.id).not.toBe(proposalsB[0]!.id);
    // Foreign reads are uniformly not-found — no existence leak.
    await expectCode('proposal_not_found', () =>
      emergent.getRoleProposal(isoB, { proposalId: proposalIsoA }),
    );
    await expectCode('gap_evidence_not_found', () =>
      emergent.getGapEvidence(isoB, { gapEvidenceId: gapIsoA }),
    );
    // A foreign gap record cannot be cited into a foreign-tenant proposal.
    await expectCode('gap_evidence_not_found', () =>
      emergent.createRoleProposal(isoB, {
        ...proposalInput([gapIsoA, newId()], capabilityIsoB),
      }),
    );
    // Lists never leak across the boundary.
    const gapsB = await emergent.listGapEvidence(isoB);
    expect(gapsB.every((gap) => gap.tenantId === tenantIsoB)).toBe(true);
    // Foreign submissions/activations on a foreign proposal are refused.
    await expectCode('proposal_not_found', () =>
      emergent.recordMarketplaceSubmission(isoB, {
        proposalId: proposalIsoA,
        packageId: pkgInstallable.id,
      }),
    );
    await expectCode('proposal_not_found', () =>
      emergent.recordRoleActivation(isoB, {
        proposalId: proposalIsoA,
        recruitmentProposalId: recruitmentApproved.id,
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

describe('reads — deterministic orders and filters', () => {
  it('lists proposals newest-first with status/origin filters', async () => {
    const gov = member(tenantGov);
    const all = await emergent.listRoleProposals(gov);
    expect(all.length).toBeGreaterThanOrEqual(4);
    for (let i = 1; i < all.length; i += 1) {
      expect(all[i - 1]!.createdAt >= all[i]!.createdAt).toBe(true);
    }
    const fulfilled = await emergent.listRoleProposals(gov, { status: 'fulfilled' });
    expect(fulfilled.map((row) => row.slug)).toEqual(['lab-site-surveyor-role']);
    expect(fulfilled[0]!.originKind).toBe('org-lab');
    expect(fulfilled[0]!.recommendationId).toBe(recommendationNegative.id);
    expect(fulfilled[0]!.demandCount).toBe(1);
    expect(fulfilled[0]!.citationCount).toBe(3);
    expect(fulfilled[0]!.alternativeCount).toBe(2);
    const drafts = await emergent.listRoleProposals(gov, {
      status: 'draft',
      originKind: 'tenant-operator',
    });
    expect(drafts.every((row) => row.originKind === 'tenant-operator')).toBe(true);
    expect(drafts.map((row) => row.slug)).toEqual(['site-surveyor-role']);
    // Query validation still guards the surface.
    await expectCode('invalid_query', () =>
      emergent.listRoleProposals(gov, { status: 'active' as never }),
    );
  });

  it('lists gap evidence on the evidence timeline with seam filters', async () => {
    const gov = member(tenantGov);
    const all = await emergent.listGapEvidence(gov);
    expect(all.map((gap) => gap.id)).toEqual([gapOutcomeId, gapRecommendationId, gapRunId]);
    const fromRuns = await emergent.listGapEvidence(gov, { sourceKind: 'execution-run' });
    expect(fromRuns.map((gap) => gap.id)).toEqual([gapRunId]);
    const forCapability = await emergent.listGapEvidence(gov, { capabilityId: capabilityGov });
    expect(forCapability).toHaveLength(3);
    const empty = await emergent.listGapEvidence(gov, { capabilityId: newId() });
    expect(empty).toEqual([]);
  });

  it('scopes submissions and activations to their proposal', async () => {
    const gov = member(tenantGov);
    const submissions = await emergent.listMarketplaceSubmissions(gov, {
      proposalId: labProposalId,
    });
    expect(submissions).toHaveLength(1);
    expect(submissions[0]!.packageKey).toBe('w138-site-surveyor');
    const none = await emergent.listMarketplaceSubmissions(gov, { proposalId: govProposalId });
    expect(none).toEqual([]);
    await expectCode('invalid_query', () =>
      emergent.listMarketplaceSubmissions(gov, { proposalId: 'nope' }),
    );
  });
});
