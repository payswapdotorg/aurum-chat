// Wave C integration (2026-10-08) — Tenant Isolation Verification · sweep
// for the emergent-roles module (W138: Emergent Roles + Marketplace
// Publication — the evidence-backed emergence projection: gap evidence,
// role proposals, governed reviews, marketplace submission requests and
// activation records).
//
// REAL two-tenant service proof in the W044 house style (the manifest v11
// registration): tenant A builds emergence state through the public
// contract — gap evidence over REAL settled-MISSED W040 outcomes and a
// REAL FAILED W136 execution run (goal → plan → failed agent execution →
// recorded run, all through the consumed seams), an evidence-backed role
// proposal citing them, the one-way lifecycle through a REAL decided W009
// review, a marketplace submission REQUEST against a REAL W028 agent
// package walked to INSTALLABLE through the governed chain, and an
// activation RECORD citing a REAL APPROVED W022 acquisition — and tenant
// B must see none of it:
//
//   * empty-list invisibility — B's listRoleProposals / listGapEvidence
//     are empty before it creates its own state, and its proposal-scoped
//     submission/activation lists are empty over A's proposal ids;
//   * uniform not-found — a FOREIGN proposal id and a MISSING one reject
//     identically on every surface (`proposal_not_found` on the read,
//     the lifecycle transitions, the review, the submission and the
//     activation; `gap_evidence_not_found` on the gap read and on citing
//     a foreign gap into a proposal), and the mapped
//     `capability_ref_not_found` / `outcome_ref_not_found` /
//     `plan_ref_not_found` from the consumed contracts cover the
//     composition paths — no existence leak (ADR-0001);
//   * same natural keys coexist per tenant — the tenant-unique proposal
//     slug and the same capability name live independently in both
//     tenants with fully isolated evidence tails;
//   * writes never mutate another tenant's rows — B cannot submit,
//     withdraw, review, publish or activate A's proposal, cannot cite
//     A's gap evidence, and cannot even source gap evidence from A's
//     capability, A's settled outcome or A's failed run (the consumed
//     seams' uniform not-founds — the stolen-body precedent).
//
// Scope rules honored here: emergent-roles code is imported ONLY through
// '@/modules/emergent-roles/contract'; the capabilities/learning/goals/
// agents/agent-exchange/actions/marketplace/agent-recruitment fixtures
// come through their public contracts (the consumed seams, exercised as
// real records — never direct SQL writes).

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { runMigrations } from '../../scripts/migrate';

import {
  createRoleProposal,
  getGapEvidence,
  getRoleProposal,
  listGapEvidence,
  listMarketplaceSubmissions,
  listRoleActivations,
  listRoleProposals,
  recordGapEvidence,
  recordMarketplaceSubmission,
  recordProposalReview,
  recordRoleActivation,
  submitRoleProposal,
  withdrawRoleProposal,
  EmergentRolesError,
} from '@/modules/emergent-roles/contract';
import type { EmergentRolesErrorCode } from '@/modules/emergent-roles/contract';
import { registerCapability } from '@/modules/capabilities/contract';
import {
  defineOutcome,
  recordMeasurement,
  settleOutcome,
} from '@/modules/learning/contract';
import type { Outcome } from '@/modules/learning/contract';
import { createGoal } from '@/modules/goals/contract';
import {
  registerAgent,
  runAgentExecution,
  setAgentTransport,
  submitAgentExecution,
} from '@/modules/agents/contract';
import type { AgentRuntimeTransport } from '@/modules/agents/contract';
import { createExecutionPlan, recordExecutionRun } from '@/modules/agent-exchange/contract';
import { authorizeAction, decideApproval } from '@/modules/actions/contract';
import {
  createPackage,
  makePackageInstallable,
  publishPackage,
  reviewPackage,
  runAutomatedVerification,
  submitPackage,
} from '@/modules/marketplace/contract';
import {
  createRecruitmentProposal,
  requestRecruitmentApproval,
  settleRecruitmentProposal,
} from '@/modules/agent-recruitment/contract';

const tenantSweepA = newId();
const tenantSweepB = newId();
const tenantVendor = newId();
const tenantPlatform = newId();

function member(
  tenantId: string,
  principalId = newId(),
  authority: string[] = [],
): TenantContext {
  return { tenantId, principalId, authority };
}

function administer(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: ['agents:administer'] };
}

function approver(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: ['actions:approve'] };
}

async function expectCode(code: EmergentRolesErrorCode, fn: () => unknown): Promise<void> {
  try {
    await fn();
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(EmergentRolesError);
    expect((error as EmergentRolesError).code).toBe(code);
  }
}

function sweepGoalInput(title: string) {
  return {
    title,
    objective: `Objective of ${title}`,
    desiredState: `Desired state of ${title}`,
    horizonEnd: '2027-12-31T00:00:00.000Z',
    owner: { kind: 'team' as const, label: 'operations' },
    priority: 'high' as const,
    successCriteria: 'Measurable success',
    actor: { kind: 'system' as const, label: 'w138-sweep' },
  };
}

/** One OPEN W040 outcome whose expected value is 10 (at_least) — a value below 10 settles it MISSED. */
async function missedOutcome(ctx: TenantContext, metricName: string): Promise<Outcome> {
  const outcome = await defineOutcome(ctx, {
    subject: { kind: 'recommendation', id: newId(), label: 'w138 sweep recommendation' },
    metricName,
    metricUnit: 'count',
    direction: 'at_least',
    baseline: 0,
    expected: 10,
    horizon: null,
    affectedGoals: [],
    originExecutionId: null,
    actor: { kind: 'person', label: 'ops lead' },
    rationale: 'the w138 sweep commitment',
  });
  const measurement = await recordMeasurement(ctx, {
    outcomeId: outcome.id,
    value: 4,
    actor: { kind: 'system', label: 'metrics-warehouse' },
  });
  await settleOutcome(ctx, {
    outcomeId: outcome.id,
    measurementId: measurement.id,
    actor: { kind: 'person', label: 'ops lead' },
  });
  return outcome;
}

/** One REAL FAILED W136 execution run (the third gap-evidence seam). */
async function failedRunFixture(
  ctx: TenantContext,
  admin: TenantContext,
  failAgentId: string,
  title: string,
): Promise<{ planId: string; runId: string }> {
  const goal = await createGoal(ctx, sweepGoalInput(title));
  const plan = await createExecutionPlan(ctx, {
    goalId: goal.id,
    objective: `Execute ${title} and fail visibly`,
    tasks: [{ taskKey: 'survey', title: 'Survey the site' }],
    members: [
      { memberKey: 'lead', kind: 'tenant-agent' as const, role: 'Lead specialist', ref: failAgentId },
    ],
  });
  const execution = await submitAgentExecution(ctx, {
    agentId: failAgentId,
    task: { instruction: 'Survey the site', context: 'sweep window' },
    requestedPermissions: ['observe'],
  });
  const failed = await runAgentExecution(ctx, { executionId: execution.id });
  expect(failed.status).toBe('failed'); // fixture invariant
  const run = await recordExecutionRun(ctx, {
    planId: plan.id,
    taskKey: 'survey',
    agentExecutionId: execution.id,
  });
  return { planId: plan.id, runId: run.id };
}

/** One decided W009 review request (approved) for the proposal review. */
async function approvedReviewRequest(ctx: TenantContext, what: string): Promise<string> {
  const request = await authorizeAction(ctx, {
    actionKind: 'role-proposal-review',
    authorityLevel: 'EXECUTE',
    payload: { what },
    justification: `the w138 sweep review of ${what}`,
  });
  await decideApproval(approver(ctx.tenantId), { requestId: request.id, decision: 'approve' });
  return request.id;
}

/** One APPROVED W022 recruitment proposal (the acquisition side). */
async function approvedRecruitment(ctx: TenantContext, capabilityId: string): Promise<string> {
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
  await decideApproval(approver(ctx.tenantId), {
    requestId: submitted.approval.actionRequestId!,
    decision: 'approve',
  });
  const settled = await settleRecruitmentProposal(ctx, { proposalId: proposal.id });
  return settled.id;
}

/** The evidence-backed proposal input over the given real citations. */
function sweepProposalInput(citations: string[], capabilityId: string) {
  return {
    slug: 'sweep-surveyor-role',
    title: 'Site Surveyor',
    origin: { kind: 'tenant-operator' as const },
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

// The failing agent's id, assigned inside the test body BEFORE the
// failed-run fixture dispatches (the transport reads it at send time).
let sweepFailAgentId = '';

beforeAll(async () => {
  await runMigrations(getDb());
  // The in-process fake transport (the sanctioned W021 wiring seam): the
  // fail fixture's dispatches are REFUSED by the runtime (a permanent
  // rejection → the execution settles terminal 'failed'); every other
  // agent delivers the openai-assistants dialect. No real provider is
  // contacted, ever.
  const fakeTransport: AgentRuntimeTransport = {
    send: async (request) => {
      if (request.agentId === sweepFailAgentId) {
        return {
          status: 'rejected' as const,
          payload: null,
          providerTaskId: null,
          detail: 'no capacity in the sweep runtime',
        };
      }
      return {
        status: 'delivered' as const,
        payload: {
          id: 'run_w138_sweep',
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
        providerTaskId: 'run_w138_sweep',
        detail: null,
      };
    },
  };
  setAgentTransport(fakeTransport);
}, 300_000);

afterAll(async () => {
  await closeDb();
});

describe('W044 emergent-roles — the emergence projection (W138) is tenant-scoped', () => {
  it("tenant A's gap evidence, proposals, reviews, submissions and activations are invisible to tenant B; the same slug and capability name coexist per tenant", async () => {
    const ctxA = member(tenantSweepA);
    const ctxAAdmin = administer(tenantSweepA);
    const ctxB = member(tenantSweepB);

    // ---- Tenant A: the emergence state, through the real seams --------
    const capabilityA = await registerCapability(ctxA, {
      name: 'sweep-site-survey',
      actor: { kind: 'person', id: 'sweep-actor-a' },
    });
    const outcomeA1 = await missedOutcome(ctxA, 'sweep-a-1');
    const outcomeA2 = await missedOutcome(ctxA, 'sweep-a-2');
    const gapA1 = await recordGapEvidence(ctxA, {
      capabilityId: capabilityA.id,
      source: { kind: 'learning-outcome', outcomeId: outcomeA1.id },
      observation: 'The first missed window.',
    });
    const gapA2 = await recordGapEvidence(ctxA, {
      capabilityId: capabilityA.id,
      source: { kind: 'learning-outcome', outcomeId: outcomeA2.id },
      observation: 'The second missed window.',
    });
    expect(gapA1.tenantId).toBe(tenantSweepA);

    // The third seam: a REAL FAILED W136 execution run as gap evidence.
    sweepFailAgentId = (await registerAgent(ctxAAdmin, {
      slug: 'sweep-fail-specialist',
      displayName: 'Sweep fail specialist',
      role: 'specialist execution',
      description: 'Fails the sweep dispatch.',
      provider: 'openai-assistants',
      instructions: 'Attempt the task and fail.',
      permissions: ['observe'],
      runtimeConfig: { assistantId: 'asst_w138_sweep_fail' },
    })).agent.id;
    const failedA = await failedRunFixture(ctxA, ctxAAdmin, sweepFailAgentId, 'W138 sweep program A');
    const gapA3 = await recordGapEvidence(ctxA, {
      capabilityId: capabilityA.id,
      source: { kind: 'execution-run', planId: failedA.planId, runId: failedA.runId },
      observation: 'The dispatched survey failed outright.',
    });

    // The evidence-backed proposal over all three real citations.
    const proposalA = await createRoleProposal(ctxA, {
      ...sweepProposalInput([gapA1.id, gapA2.id, gapA3.id], capabilityA.id),
    });
    expect(proposalA.tenantId).toBe(tenantSweepA);
    expect(proposalA.slug).toBe('sweep-surveyor-role');
    expect(proposalA.status).toBe('draft');
    const submittedA = await submitRoleProposal(ctxA, { proposalId: proposalA.id });
    expect(submittedA.status).toBe('under_review');
    const reviewA = await recordProposalReview(ctxA, {
      proposalId: proposalA.id,
      actionRequestId: await approvedReviewRequest(ctxA, 'the sweep surveyor proposal'),
    });
    expect(reviewA.decision.status).toBe('approved');

    // The governed marketplace chain (the REAL W028 path, walked by the
    // vendor + platform tenants) and the submission REQUEST over it.
    const vendor = member(tenantVendor, newId(), ['marketplace:submit']);
    const platform = member(tenantPlatform, newId(), ['marketplace:administer']);
    const pkgCreated = await createPackage(vendor, {
      kind: 'agent',
      packageKey: 'w138-sweep-site-surveyor',
      version: '1.0.0',
      displayName: 'Sweep Site Surveyor',
      description: 'Surveys sites.',
      role: 'Site surveyor',
      instructions: 'Survey the site and report.',
      provider: 'langgraph',
      permissions: ['analyze', 'observe'],
    });
    const pkgSubmitted = await submitPackage(vendor, { packageId: pkgCreated.id });
    await runAutomatedVerification(platform, { packageId: pkgSubmitted.id });
    await reviewPackage(platform, { packageId: pkgSubmitted.id, decision: 'approve', reason: 'Clean artifact' });
    await publishPackage(platform, { packageId: pkgSubmitted.id });
    const pkgInstallable = await makePackageInstallable(platform, { packageId: pkgSubmitted.id });
    expect(pkgInstallable.state).toBe('INSTALLABLE'); // fixture invariant

    const submissionA = await recordMarketplaceSubmission(ctxA, {
      proposalId: proposalA.id,
      packageId: pkgInstallable.id,
      note: 'Through the governed chain.',
    });
    expect(submissionA.packageKey).toBe('w138-sweep-site-surveyor');

    // The activation RECORD over a REAL APPROVED W022 acquisition.
    const recruitmentA = await approvedRecruitment(ctxA, capabilityA.id);
    const activationA = await recordRoleActivation(ctxA, {
      proposalId: proposalA.id,
      recruitmentProposalId: recruitmentA,
      note: 'The specialist joined the crew.',
    });
    expect(activationA.tenantId).toBe(tenantSweepA);
    const fulfilledA = await getRoleProposal(ctxA, { proposalId: proposalA.id });
    expect(fulfilledA.status).toBe('fulfilled');

    // ---- Tenant B sees none of it ---------------------------------------
    expect(await listRoleProposals(ctxB)).toHaveLength(0);
    expect(await listGapEvidence(ctxB)).toHaveLength(0);
    // The proposal-scoped evidence lists follow the filtered-list house
    // style: a foreign proposal is an EMPTY list, never an existence leak.
    expect(await listMarketplaceSubmissions(ctxB, { proposalId: proposalA.id })).toEqual([]);
    expect(await listRoleActivations(ctxB, { proposalId: proposalA.id })).toEqual([]);

    // Uniform not-founds: a FOREIGN proposal id and a MISSING one are
    // indistinguishable on the read, the lifecycle, the review, the
    // submission and the activation.
    await expectCode('proposal_not_found', () =>
      getRoleProposal(ctxB, { proposalId: proposalA.id }),
    );
    await expectCode('proposal_not_found', () =>
      getRoleProposal(ctxB, { proposalId: newId() }),
    );
    await expectCode('proposal_not_found', () =>
      submitRoleProposal(ctxB, { proposalId: proposalA.id }),
    );
    await expectCode('proposal_not_found', () =>
      withdrawRoleProposal(ctxB, { proposalId: proposalA.id, reason: 'cross-tenant probe' }),
    );
    await expectCode('proposal_not_found', () =>
      recordProposalReview(ctxB, { proposalId: proposalA.id, actionRequestId: newId() }),
    );
    await expectCode('proposal_not_found', () =>
      recordMarketplaceSubmission(ctxB, { proposalId: proposalA.id, packageId: pkgInstallable.id }),
    );
    await expectCode('proposal_not_found', () =>
      recordRoleActivation(ctxB, { proposalId: proposalA.id, recruitmentProposalId: recruitmentA }),
    );

    // A FOREIGN gap-evidence record is uniformly not-found on the read
    // and as a citation inside B's own proposal.
    await expectCode('gap_evidence_not_found', () =>
      getGapEvidence(ctxB, { gapEvidenceId: gapA1.id }),
    );
    await expectCode('gap_evidence_not_found', () =>
      getGapEvidence(ctxB, { gapEvidenceId: newId() }),
    );
    const capabilityB = await registerCapability(ctxB, {
      name: 'sweep-site-survey',
      actor: { kind: 'person', id: 'sweep-actor-b' },
    });
    await expectCode('gap_evidence_not_found', () =>
      createRoleProposal(ctxB, {
        ...sweepProposalInput([gapA1.id, newId()], capabilityB.id),
      }),
    );

    // B cannot SOURCE gap evidence from A's records either: not from A's
    // capability (the W017 seam's uniform not-found), not from A's
    // settled-MISSED outcome (the W040 seam's), and not from A's failed
    // run (the W136 seam's — the stolen-body precedent).
    const outcomeB1 = await missedOutcome(ctxB, 'sweep-b-1');
    await expectCode('capability_ref_not_found', () =>
      recordGapEvidence(ctxB, {
        capabilityId: capabilityA.id,
        source: { kind: 'learning-outcome', outcomeId: outcomeB1.id },
        observation: 'cross-tenant probe',
      }),
    );
    await expectCode('outcome_ref_not_found', () =>
      recordGapEvidence(ctxB, {
        capabilityId: capabilityB.id,
        source: { kind: 'learning-outcome', outcomeId: outcomeA1.id },
        observation: 'cross-tenant probe',
      }),
    );
    await expectCode('plan_ref_not_found', () =>
      recordGapEvidence(ctxB, {
        capabilityId: capabilityB.id,
        source: { kind: 'execution-run', planId: failedA.planId, runId: failedA.runId },
        observation: 'cross-tenant probe',
      }),
    );

    // ---- The same natural keys coexist per tenant ------------------------
    // The same capability name and the tenant-unique proposal slug
    // 'sweep-surveyor-role' live independently in B, over B's own gap
    // evidence, and B's proposal walks its own full lifecycle (the
    // surface serves B normally — isolation is not breakage).
    const outcomeB2 = await missedOutcome(ctxB, 'sweep-b-2');
    const gapB1 = await recordGapEvidence(ctxB, {
      capabilityId: capabilityB.id,
      source: { kind: 'learning-outcome', outcomeId: outcomeB1.id },
      observation: 'The first missed window.',
    });
    const gapB2 = await recordGapEvidence(ctxB, {
      capabilityId: capabilityB.id,
      source: { kind: 'learning-outcome', outcomeId: outcomeB2.id },
      observation: 'The second missed window.',
    });
    const proposalB = await createRoleProposal(ctxB, {
      ...sweepProposalInput([gapB1.id, gapB2.id], capabilityB.id),
    });
    expect(proposalB.id).not.toBe(proposalA.id);
    expect(proposalB.tenantId).toBe(tenantSweepB);
    expect(proposalB.slug).toBe(proposalA.slug);
    await submitRoleProposal(ctxB, { proposalId: proposalB.id });
    await recordProposalReview(ctxB, {
      proposalId: proposalB.id,
      actionRequestId: await approvedReviewRequest(ctxB, 'the sweep surveyor proposal'),
    });
    // B records its own submission over the SAME globally-visible
    // INSTALLABLE package and its own approved acquisition.
    const submissionB = await recordMarketplaceSubmission(ctxB, {
      proposalId: proposalB.id,
      packageId: pkgInstallable.id,
    });
    expect(submissionB.tenantId).toBe(tenantSweepB);
    const recruitmentB = await approvedRecruitment(ctxB, capabilityB.id);
    const activationB = await recordRoleActivation(ctxB, {
      proposalId: proposalB.id,
      recruitmentProposalId: recruitmentB,
    });
    expect(activationB.tenantId).toBe(tenantSweepB);

    // Each tenant's lists hold exactly their own rows.
    expect((await listRoleProposals(ctxA)).map((p) => p.id)).toEqual([proposalA.id]);
    expect((await listRoleProposals(ctxB)).map((p) => p.id)).toEqual([proposalB.id]);
    expect((await listGapEvidence(ctxA)).map((g) => g.id)).toEqual([gapA1.id, gapA2.id, gapA3.id]);
    expect((await listGapEvidence(ctxB)).map((g) => g.id)).toEqual([gapB1.id, gapB2.id]);
    expect((await listMarketplaceSubmissions(ctxA, { proposalId: proposalA.id })).map((s) => s.id)).toEqual([
      submissionA.id,
    ]);
    expect((await listMarketplaceSubmissions(ctxB, { proposalId: proposalB.id })).map((s) => s.id)).toEqual([
      submissionB.id,
    ]);
    expect((await listRoleActivations(ctxA, { proposalId: proposalA.id })).map((a) => a.id)).toEqual([
      activationA.id,
    ]);
    expect((await listRoleActivations(ctxB, { proposalId: proposalB.id })).map((a) => a.id)).toEqual([
      activationB.id,
    ]);
    // A's fulfilled proposal is untouched by any of B's probes.
    expect((await getRoleProposal(ctxA, { proposalId: proposalA.id })).status).toBe('fulfilled');
    expect((await getRoleProposal(ctxB, { proposalId: proposalB.id })).status).toBe('fulfilled');
  });
});
