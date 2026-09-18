// Integration tests for the agent-recruitment module against the embedded
// PostgreSQL (PGlite, `:memory:`) through the db port. Covers the W022
// acceptance: "Create AgentRecruitmentProposal comparing train/reassign/
// hire/automate/recruit/install alternatives. Approval is explicit."
//
//  * the comparison — a proposal records 2..6 alternatives with distinct
//    kinds (one per acquisition channel), each assessed on the same
//    dimensions (cost + ISO currency, weeks to impact, capability level/
//    capacity contribution), at most one recommended; a 'recruit'
//    alternative carries the future agent's permission grant (the agents
//    module's closed vocabulary) with its implied §20 level derived on
//    read; the capability link is verified and SNAPSHOTTED through the
//    capabilities contract (W017) — gap classification and numbers frozen
//    at creation, including the out-of-gap-scope (null) case;
//  * explicit approval — submission routes through the W009 authority
//    matrix (kind 'agent-recruitment', level EXECUTE): the built-in
//    default gates it behind a human decision (awaiting_approval → a
//    DIFFERENT authorized principal decides through the actions module →
//    settle lands approved/rejected with the deciding principal and
//    time); the requesting principal can never decide its own proposal
//    (separation of duties); a tenant policy that explicitly ALLOWS
//    EXECUTE auto-approves with a recorded POLICY decision; a policy
//    that FORBIDS rejects outright;
//  * idempotent submission — the gate key is derived from the proposal
//    id, so an interrupted submission replays the SAME action request
//    (first write wins, no forked history);
//  * lifecycle discipline — only a draft can be submitted or withdrawn;
//    withdrawal requires the author or an agent-workforce administrator
//    ('agents:administer') and records a reason; settle is an idempotent
//    read on drafts, open gates and terminal states;
//  * reads — filtered listing (status, capability, recommended kind,
//    limit) in newest-first order; the uniform cross-tenant not-found
//    discipline (ADR-0001): another tenant's capability, proposals and
//    gate links are indistinguishable from missing ones;
//  * storage-level immutability — PostgreSQL itself rejects substantive
//    UPDATEs on proposals, any UPDATE/DELETE on alternatives, and
//    DELETE/TRUNCATE on both tables (a recorded comparison and decision
//    are history, not editable state).

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import * as recruitmentContract from '../contract';
import * as capabilitiesContract from '@/modules/capabilities/contract';
import * as actionsContract from '@/modules/actions/contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { AgentRecruitmentError } from '../errors';
import type { CreateRecruitmentProposalInput } from '../types';
import { runMigrations } from '../../../../scripts/migrate';

const {
  createRecruitmentProposal,
  getRecruitmentProposal,
  listRecruitmentProposals,
  requestRecruitmentApproval,
  settleRecruitmentProposal,
  withdrawRecruitmentProposal,
} = recruitmentContract;

const { registerCapability, registerRequirement, registerSupply } = capabilitiesContract;
const { authorizeAction, decideApproval, listActionRequests, listApprovalDecisions, setAuthorityPolicy } =
  actionsContract;

// Dedicated tenants per group so count/order assertions stay deterministic.
const tenantCreate = newId();
const tenantValidation = newId();
const tenantReads = newId();
const tenantGate = newId();
const tenantReject = newId();
const tenantAllow = newId();
const tenantForbid = newId();
const tenantWithdraw = newId();
const tenantIdempotency = newId();
const tenantIsolation = newId();
const tenantOther = newId();
const tenantStorage = newId();

function member(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: [] };
}

function approver(tenantId: string): TenantContext {
  // A DIFFERENT principal with the actions approval claim (separation of duties).
  return { tenantId, principalId: newId(), authority: ['actions:approve'] };
}

function actionsAdmin(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: ['actions:administer'] };
}

function agentsAdmin(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: ['agents:administer'] };
}

async function expectCode(
  code: AgentRecruitmentError['code'],
  fn: () => Promise<unknown>,
): Promise<void> {
  try {
    await fn();
    throw new Error(`expected AgentRecruitmentError('${code}') but the call succeeded`);
  } catch (error) {
    expect(error).toBeInstanceOf(AgentRecruitmentError);
    expect((error as AgentRecruitmentError).code).toBe(code);
  }
}

// ---------------------------------------------------------------------------
// Capability fixtures (through the capabilities contract — W017)
// ---------------------------------------------------------------------------

interface CapabilityFixture {
  id: string;
  name: string;
}

async function capabilityWithGap(
  ctx: TenantContext,
  name: string,
  gap: { requirementLevel?: number; requirementCapacity?: number | null; supplyLevel?: number; supplyCapacity?: number | null },
): Promise<CapabilityFixture> {
  const actor = { kind: 'person' as const, id: 'fixture-actor' };
  const capability = await registerCapability(ctx, { name, actor });
  if (gap.requirementLevel !== undefined || gap.requirementCapacity !== undefined) {
    await registerRequirement(ctx, {
      capabilityId: capability.id,
      source: { kind: 'manual', id: `${name}-need` },
      level: gap.requirementLevel ?? 0,
      capacity: gap.requirementCapacity ?? null,
      actor,
    });
  }
  if (gap.supplyLevel !== undefined) {
    await registerSupply(ctx, {
      capabilityId: capability.id,
      supplier: { kind: 'employee', id: `${name}-supplier` },
      level: gap.supplyLevel,
      capacity: gap.supplyCapacity ?? null,
      actor,
    });
  }
  return { id: capability.id, name: capability.name };
}

function proposalInput(
  capabilityId: string,
  overrides: Partial<CreateRecruitmentProposalInput> = {},
): CreateRecruitmentProposalInput {
  return {
    title: 'Close the German-language support gap',
    capabilityId,
    rationale: 'German support volume tripled; the gap now delays first response beyond policy.',
    evidenceObservationIds: ['00000000-0000-4000-8000-0000000000o1'],
    alternatives: [
      {
        kind: 'train',
        summary: 'Train Ada to full German-language proficiency.',
        note: 'Ada already handles written German at B1.',
        estimatedCostMinor: 450000,
        estimatedWeeks: 6,
        expectedLevel: 0.8,
      },
      {
        kind: 'hire',
        summary: 'Hire a fluent German-speaking support engineer.',
        estimatedCostMinor: 12345678901,
        estimatedCostCurrency: 'EUR',
        estimatedWeeks: 12,
        expectedLevel: 1,
        expectedCapacity: 40,
      },
      {
        kind: 'recruit',
        summary: 'Recruit a German-support agent on a managed runtime.',
        estimatedCostMinor: 120000,
        estimatedWeeks: 1,
        expectedLevel: 1,
        recommended: true,
        agentPermissions: ['propose', 'observe', 'analyze'],
      },
    ],
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
// The comparison
// ---------------------------------------------------------------------------

describe('createRecruitmentProposal — the comparison', () => {
  it('records the six-channel comparison with the capability snapshot', async () => {
    const ctx = member(tenantCreate);
    const capability = await capabilityWithGap(ctx, 'German-language support', {
      requirementLevel: 0.8,
      supplyLevel: 0.5,
    });

    const proposal = await createRecruitmentProposal(ctx, proposalInput(capability.id));

    expect(proposal.status).toBe('proposed');
    expect(proposal.title).toBe('Close the German-language support gap');
    expect(proposal.createdBy).toBe(ctx.principalId);
    expect(proposal.evidenceObservationIds).toEqual(['00000000-0000-4000-8000-0000000000o1']);

    // The §15 "existing capability" snapshot, frozen at creation.
    expect(proposal.capability).toEqual({
      capabilityId: capability.id,
      capabilityName: 'German-language support',
      capabilityStatus: 'active',
      gapStatus: 'level_shortfall',
      bestActiveLevel: 0.5,
      totalActiveCapacity: 0,
    });

    // Canonical kind order; every channel assessed on the same dimensions.
    expect(proposal.alternatives.map((alternative) => alternative.kind)).toEqual([
      'train',
      'hire',
      'recruit',
    ]);
    const train = proposal.alternatives[0]!;
    expect(train.estimatedCostCurrency).toBe('USD'); // defaulted
    expect(train.recommended).toBe(false);
    expect(train.agentPermissions).toBeNull();
    expect(train.impliedAuthorityLevel).toBeNull();
    const hire = proposal.alternatives[1]!;
    expect(hire.estimatedCostMinor).toBe(12345678901); // bigint round-trip
    expect(hire.estimatedCostCurrency).toBe('EUR');
    expect(hire.expectedCapacity).toBe(40);
    const recruit = proposal.alternatives[2]!;
    expect(recruit.recommended).toBe(true);
    expect(recruit.agentPermissions).toEqual(['observe', 'analyze', 'propose']); // canonical order
    expect(recruit.impliedAuthorityLevel).toBe('PROPOSE'); // highest §20 level implied

    // The recommendation is the flagged alternative.
    expect(proposal.recommendation?.kind).toBe('recruit');
    expect(proposal.recommendation?.id).toBe(recruit.id);

    // A fresh proposal has not touched the gate.
    expect(proposal.approval).toEqual({
      actionRequestId: null,
      policyOutcome: null,
      policyResolvedVia: null,
      submittedBy: null,
      submittedAt: null,
      decidedBy: null,
      decidedByPrincipal: null,
      decidedAt: null,
    });
    expect(proposal.withdrawnAt).toBeNull();
    expect(proposal.withdrawalReason).toBeNull();
  });

  it('snapshots a covered gap and an out-of-gap-scope capability', async () => {
    const ctx = member(tenantCreate);
    const covered = await capabilityWithGap(ctx, 'Invoice processing', {
      requirementLevel: 0,
      supplyLevel: 1,
      supplyCapacity: 120,
    });
    const uncoveredScope = await capabilityWithGap(ctx, 'Preventive compliance auditing', {});

    const coveredProposal = await createRecruitmentProposal(
      ctx,
      proposalInput(covered.id, { title: 'Covered already — keep watching' }),
    );
    expect(coveredProposal.capability.gapStatus).toBe('covered');
    expect(coveredProposal.capability.bestActiveLevel).toBe(1);
    expect(coveredProposal.capability.totalActiveCapacity).toBe(120);

    const outOfScope = await createRecruitmentProposal(
      ctx,
      proposalInput(uncoveredScope.id, { title: 'New capability argument' }),
    );
    // No active requirements → out of gap-analysis scope → null snapshot.
    expect(outOfScope.capability.gapStatus).toBeNull();
    expect(outOfScope.capability.bestActiveLevel).toBeNull();
    expect(outOfScope.capability.totalActiveCapacity).toBeNull();
  });

  it('compares all six channels when asked to', async () => {
    const ctx = member(tenantCreate);
    const capability = await capabilityWithGap(ctx, 'Dutch-language support', {
      requirementLevel: 0.5,
    });
    const proposal = await createRecruitmentProposal(
      ctx,
      proposalInput(capability.id, {
        title: 'Full six-channel comparison',
        alternatives: [
          { kind: 'train', summary: 't' },
          { kind: 'reassign', summary: 'r' },
          { kind: 'hire', summary: 'h' },
          { kind: 'automate', summary: 'a' },
          { kind: 'recruit', summary: 'c' },
          { kind: 'install', summary: 'i', recommended: true },
        ],
      }),
    );
    expect(proposal.alternatives.map((alternative) => alternative.kind)).toEqual([
      'train',
      'reassign',
      'hire',
      'automate',
      'recruit',
      'install',
    ]);
    expect(proposal.recommendation?.kind).toBe('install');
    // No recommendation is legal too.
    const undecided = await createRecruitmentProposal(
      ctx,
      proposalInput(capability.id, {
        title: 'No clear winner yet',
        alternatives: [
          { kind: 'train', summary: 't' },
          { kind: 'automate', summary: 'a' },
        ],
      }),
    );
    expect(undecided.recommendation).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Validation at the service boundary + the capability link
// ---------------------------------------------------------------------------

describe('the capability link and service-boundary validation', () => {
  it('rejects a missing capability', async () => {
    const ctx = member(tenantValidation);
    await expectCode('capability_not_found', () =>
      createRecruitmentProposal(ctx, proposalInput(newId())),
    );
  });

  it('treats another tenant\'s capability as missing (no existence leak)', async () => {
    const otherCtx = member(tenantOther);
    const foreign = await capabilityWithGap(otherCtx, 'Foreign tenant capability', {
      requirementLevel: 0.5,
    });
    const ctx = member(tenantValidation);
    // The same code and shape as a missing id — indistinguishable.
    await expectCode('capability_not_found', () =>
      createRecruitmentProposal(ctx, proposalInput(foreign.id)),
    );
  });

  it('enforces the comparison rules at the service boundary', async () => {
    const ctx = member(tenantValidation);
    const capability = await capabilityWithGap(ctx, 'Escalation handling', {
      requirementLevel: 0.6,
      supplyLevel: 0.2,
    });

    await expectCode('invalid_proposal_input', () =>
      createRecruitmentProposal(
        ctx,
        proposalInput(capability.id, {
          alternatives: [{ kind: 'train', summary: 'only one channel is not a comparison' }],
        }),
      ),
    );
    await expectCode('invalid_proposal_input', () =>
      createRecruitmentProposal(
        ctx,
        proposalInput(capability.id, {
          alternatives: [
            { kind: 'train', summary: 't' },
            { kind: 'train', summary: 't again' },
          ],
        }),
      ),
    );
    await expectCode('invalid_proposal_input', () =>
      createRecruitmentProposal(
        ctx,
        proposalInput(capability.id, {
          alternatives: [
            { kind: 'train', summary: 't', recommended: true },
            { kind: 'hire', summary: 'h', recommended: true },
          ],
        }),
      ),
    );
    await expectCode('invalid_proposal_input', () =>
      createRecruitmentProposal(
        ctx,
        proposalInput(capability.id, {
          alternatives: [
            { kind: 'automate', summary: 'a', agentPermissions: ['observe'] },
            { kind: 'hire', summary: 'h' },
          ],
        }),
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

describe('getRecruitmentProposal / listRecruitmentProposals', () => {
  it('lists with filters in newest-first order', async () => {
    const author = member(tenantReads);
    const capabilityA = await capabilityWithGap(author, 'Knowledge base curation', {
      requirementLevel: 0.4,
    });
    const capabilityB = await capabilityWithGap(author, 'Voice-of-customer analysis', {
      requirementLevel: 0.4,
    });

    const p1 = await createRecruitmentProposal(
      author,
      proposalInput(capabilityA.id, { title: 'Curation: recruit recommended' }),
    );
    const p2 = await createRecruitmentProposal(
      author,
      proposalInput(capabilityA.id, {
        title: 'Curation: train recommended',
        alternatives: [
          { kind: 'train', summary: 't', recommended: true },
          { kind: 'automate', summary: 'a' },
        ],
      }),
    );
    const p3 = await createRecruitmentProposal(
      author,
      proposalInput(capabilityB.id, {
        title: 'VoC: undecided',
        alternatives: [
          { kind: 'automate', summary: 'a' },
          { kind: 'install', summary: 'i' },
        ],
      }),
    );

    expect((await listRecruitmentProposals(author, {})).map((p) => p.id)).toEqual([p3.id, p2.id, p1.id]);
    expect((await listRecruitmentProposals(author, { status: 'proposed' })).map((p) => p.id)).toEqual([
      p3.id,
      p2.id,
      p1.id,
    ]);
    expect(
      (await listRecruitmentProposals(author, { capabilityId: capabilityA.id })).map((p) => p.id),
    ).toEqual([p2.id, p1.id]);
    expect(
      (await listRecruitmentProposals(author, { recommendedKind: 'recruit' })).map((p) => p.id),
    ).toEqual([p1.id]);
    expect(
      (await listRecruitmentProposals(author, { recommendedKind: 'train' })).map((p) => p.id),
    ).toEqual([p2.id]);
    expect(await listRecruitmentProposals(author, { recommendedKind: 'install' })).toEqual([]);
    expect((await listRecruitmentProposals(author, { limit: 1 })).map((p) => p.id)).toEqual([p3.id]);

    const fetched = await getRecruitmentProposal(author, { proposalId: p1.id });
    expect(fetched.id).toBe(p1.id);
    expect(fetched.capability.capabilityName).toBe('Knowledge base curation');

    await expectCode('proposal_not_found', () =>
      getRecruitmentProposal(author, { proposalId: newId() }),
    );
  });
});

// ---------------------------------------------------------------------------
// The explicit approval — the built-in default gate and a human decision
// ---------------------------------------------------------------------------

describe('requestRecruitmentApproval — the built-in gate and the human decision', () => {
  it('gates every submission behind a human, then lands the approval', async () => {
    const author = member(tenantGate);
    const capability = await capabilityWithGap(author, 'Portuguese-language support', {
      requirementLevel: 0.7,
    });
    const proposal = await createRecruitmentProposal(author, proposalInput(capability.id));

    // Settling a draft is an idempotent read.
    expect((await settleRecruitmentProposal(author, { proposalId: proposal.id })).status).toBe(
      'proposed',
    );

    const submitted = await requestRecruitmentApproval(author, {
      proposalId: proposal.id,
      justification: 'cheapest and fastest option for a bounded scope',
    });
    expect(submitted.status).toBe('awaiting_approval');
    expect(submitted.approval.actionRequestId).not.toBeNull();
    expect(submitted.approval.policyOutcome).toBe('approval_required');
    expect(submitted.approval.policyResolvedVia).toBe('built-in');
    expect(submitted.approval.submittedBy).toBe(author.principalId);
    expect(submitted.approval.submittedAt).not.toBeNull();
    expect(submitted.approval.decidedBy).toBeNull();
    expect(submitted.approval.decidedAt).toBeNull();

    // The request on the actions surface: kind, level, payload, requester.
    const requests = await listActionRequests(author, { actionKind: 'agent-recruitment' });
    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(request.id).toBe(submitted.approval.actionRequestId);
    expect(request.authorityLevel).toBe('EXECUTE');
    expect(request.status).toBe('pending');
    expect(request.requestedBy).toBe(author.principalId);
    expect(request.justification).toBe('cheapest and fastest option for a bounded scope');
    const payload = request.payload as Record<string, unknown>;
    expect(payload.subject).toBe('agent-recruitment-proposal');
    expect(payload.proposalId).toBe(proposal.id);
    expect(payload.capabilityName).toBe('Portuguese-language support');
    expect(payload.alternativeKinds).toEqual(['train', 'hire', 'recruit']);
    expect((payload.recommended as Record<string, unknown>).kind).toBe('recruit');

    // Only a draft can be submitted; a submitted one is decided, not re-requested.
    await expectCode('invalid_transition', () =>
      requestRecruitmentApproval(author, { proposalId: proposal.id }),
    );

    // Separation of duties: the requesting principal never decides its own
    // proposal — even holding the approval claim.
    const selfApprover: TenantContext = {
      tenantId: tenantGate,
      principalId: author.principalId,
      authority: ['actions:approve'],
    };
    await expect(
      decideApproval(selfApprover, { requestId: request.id, decision: 'approve' }),
    ).rejects.toMatchObject({ code: 'forbidden' });

    // The human decision (a different authorized principal), then settle.
    const approverCtx = approver(tenantGate);
    const decided = await decideApproval(approverCtx, {
      requestId: request.id,
      decision: 'approve',
    });
    expect(decided.status).toBe('approved');

    // Before settle, the proposal still shows the open gate.
    expect((await getRecruitmentProposal(author, { proposalId: proposal.id })).status).toBe(
      'awaiting_approval',
    );

    const settled = await settleRecruitmentProposal(member(tenantGate), { proposalId: proposal.id });
    expect(settled.status).toBe('approved');
    expect(settled.approval.actionRequestId).toBe(request.id);
    expect(settled.approval.policyOutcome).toBe('approval_required');
    expect(settled.approval.decidedBy).toBe('principal');
    expect(settled.approval.decidedByPrincipal).toBe(approverCtx.principalId);
    expect(settled.approval.decidedAt).not.toBeNull();
    // The decision trail is append-only evidence on the actions side.
    const decisions = await listApprovalDecisions(author, { requestId: request.id });
    expect(decisions.filter((decision) => decision.decidedBy === 'principal')).toHaveLength(1);

    // Settling again changes nothing; terminal is terminal.
    const again = await settleRecruitmentProposal(author, { proposalId: proposal.id });
    expect(again.status).toBe('approved');
    expect(again.approval.decidedAt).toBe(settled.approval.decidedAt);
    await expectCode('invalid_transition', () =>
      requestRecruitmentApproval(author, { proposalId: proposal.id }),
    );
    await expectCode('invalid_transition', () =>
      withdrawRecruitmentProposal(author, { proposalId: proposal.id, reason: 'too late' }),
    );
  });

  it('lands a human rejection the same way', async () => {
    const author = member(tenantReject);
    const capability = await capabilityWithGap(author, 'Onboarding paperwork automation', {
      requirementLevel: 0.5,
    });
    const proposal = await createRecruitmentProposal(author, proposalInput(capability.id));
    const submitted = await requestRecruitmentApproval(author, { proposalId: proposal.id });

    const approverCtx = approver(tenantReject);
    await decideApproval(approverCtx, {
      requestId: submitted.approval.actionRequestId as string,
      decision: 'reject',
    });
    const settled = await settleRecruitmentProposal(author, { proposalId: proposal.id });
    expect(settled.status).toBe('rejected');
    expect(settled.approval.decidedBy).toBe('principal');
    expect(settled.approval.decidedByPrincipal).toBe(approverCtx.principalId);
  });
});

// ---------------------------------------------------------------------------
// The explicit approval — tenant policy decides up front
// ---------------------------------------------------------------------------

describe('requestRecruitmentApproval — tenant policy paths', () => {
  it('auto-approves with a recorded POLICY decision when policy explicitly allows EXECUTE', async () => {
    const admin = actionsAdmin(tenantAllow);
    await setAuthorityPolicy(admin, {
      actionKind: 'agent-recruitment',
      approvalLevels: [],
      forbiddenLevels: [],
      note: 'recruitment is pre-cleared',
    });

    const author = member(tenantAllow);
    const capability = await capabilityWithGap(author, 'Social media monitoring', {
      requirementLevel: 0.5,
    });
    const proposal = await createRecruitmentProposal(author, proposalInput(capability.id));
    const submitted = await requestRecruitmentApproval(author, { proposalId: proposal.id });

    // Explicit: the tenant CONFIGURED this auto-approval; the matrix
    // recorded a policy decision, not a silent pass.
    expect(submitted.status).toBe('approved');
    expect(submitted.approval.policyOutcome).toBe('allowed');
    expect(submitted.approval.policyResolvedVia).toBe('kind');
    expect(submitted.approval.decidedBy).toBe('policy');
    expect(submitted.approval.decidedByPrincipal).toBeNull();
    expect(submitted.approval.decidedAt).not.toBeNull();

    const requests = await listActionRequests(author, { actionKind: 'agent-recruitment' });
    expect(requests[0]?.status).toBe('approved');
    const decisions = await listApprovalDecisions(author, {
      requestId: submitted.approval.actionRequestId as string,
    });
    expect(decisions.some((decision) => decision.decidedBy === 'policy' && decision.decision === 'approve')).toBe(
      true,
    );
  });

  it('rejects outright (with evidence) when policy forbids EXECUTE', async () => {
    const admin = actionsAdmin(tenantForbid);
    await setAuthorityPolicy(admin, {
      actionKind: 'agent-recruitment',
      forbiddenLevels: ['EXECUTE'],
      note: 'no new recruitment this quarter',
    });

    const author = member(tenantForbid);
    const capability = await capabilityWithGap(author, 'Field service dispatch', {
      requirementLevel: 0.5,
    });
    const proposal = await createRecruitmentProposal(author, proposalInput(capability.id));
    const submitted = await requestRecruitmentApproval(author, { proposalId: proposal.id });

    expect(submitted.status).toBe('rejected');
    expect(submitted.approval.policyOutcome).toBe('forbidden');
    expect(submitted.approval.policyResolvedVia).toBe('kind');
    expect(submitted.approval.decidedBy).toBe('policy');
    expect(submitted.approval.decidedAt).not.toBeNull();
    // Terminal: no re-submission path.
    await expectCode('invalid_transition', () =>
      requestRecruitmentApproval(author, { proposalId: proposal.id }),
    );
  });
});

// ---------------------------------------------------------------------------
// Idempotent submission (the gate key is derived from the proposal id)
// ---------------------------------------------------------------------------

describe('requestRecruitmentApproval — idempotent gate replay', () => {
  it('replays the same action request after an interrupted submission', async () => {
    const author = member(tenantIdempotency);
    const capability = await capabilityWithGap(author, 'Contract review support', {
      requirementLevel: 0.6,
    });
    const proposal = await createRecruitmentProposal(author, proposalInput(capability.id));

    // Simulate a submission that reached the gate but crashed before the
    // lifecycle update: the request exists, pending, under the same
    // proposal-derived idempotency key.
    const interrupted = await authorizeAction(author, {
      actionKind: 'agent-recruitment',
      authorityLevel: 'EXECUTE',
      payload: { subject: 'agent-recruitment-proposal', proposalId: proposal.id, note: 'interrupted' },
      idempotencyKey: `${recruitmentContract.AGENT_RECRUITMENT_ACTION_KIND}:${proposal.id}`,
    });
    expect(interrupted.status).toBe('pending');

    // The retry replays the SAME request (first write wins) instead of
    // forking a second one.
    const submitted = await requestRecruitmentApproval(author, { proposalId: proposal.id });
    expect(submitted.status).toBe('awaiting_approval');
    expect(submitted.approval.actionRequestId).toBe(interrupted.id);

    const requests = await listActionRequests(author, { actionKind: 'agent-recruitment' });
    expect(requests).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Withdrawal
// ---------------------------------------------------------------------------

describe('withdrawRecruitmentProposal', () => {
  it('lets the author or an agent-workforce administrator withdraw a draft — nobody else', async () => {
    const author = member(tenantWithdraw);
    const capability = await capabilityWithGap(author, 'Data-entry quality checks', {
      requirementLevel: 0.5,
    });

    const p1 = await createRecruitmentProposal(author, proposalInput(capability.id));
    // A different plain member may not retire someone else's draft.
    await expectCode('forbidden', () =>
      withdrawRecruitmentProposal(member(tenantWithdraw), { proposalId: p1.id, reason: 'nope' }),
    );
    // An agent-workforce administrator may (agents:administer).
    const adminWithdrawn = await withdrawRecruitmentProposal(agentsAdmin(tenantWithdraw), {
      proposalId: p1.id,
      reason: 'superseded by the consolidated proposal',
    });
    expect(adminWithdrawn.status).toBe('withdrawn');
    expect(adminWithdrawn.withdrawnAt).not.toBeNull();
    expect(adminWithdrawn.withdrawalReason).toBe('superseded by the consolidated proposal');
    // Withdrawal is terminal; settle is an idempotent read on it.
    await expectCode('invalid_transition', () =>
      withdrawRecruitmentProposal(author, { proposalId: p1.id, reason: 'again' }),
    );
    expect(
      (await settleRecruitmentProposal(author, { proposalId: p1.id })).status,
    ).toBe('withdrawn');

    // The author withdraws their own draft.
    const p2 = await createRecruitmentProposal(author, proposalInput(capability.id));
    const authorWithdrawn = await withdrawRecruitmentProposal(author, {
      proposalId: p2.id,
      reason: 'numbers were stale',
    });
    expect(authorWithdrawn.status).toBe('withdrawn');

    // A submitted proposal is decided through the gate, never un-requested.
    const p3 = await createRecruitmentProposal(author, proposalInput(capability.id));
    await requestRecruitmentApproval(author, { proposalId: p3.id });
    await expectCode('invalid_transition', () =>
      withdrawRecruitmentProposal(author, { proposalId: p3.id, reason: 'too late' }),
    );

    // The withdrawn drafts list as such, newest first.
    const withdrawn = await listRecruitmentProposals(author, { status: 'withdrawn' });
    expect(withdrawn.map((p) => p.id)).toEqual([p2.id, p1.id]);
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation
// ---------------------------------------------------------------------------

describe('tenant isolation (ADR-0001)', () => {
  it('hides another tenant\'s proposals completely', async () => {
    const otherCtx = member(tenantOther);
    const capability = await capabilityWithGap(otherCtx, 'Isolated tenant capability', {
      requirementLevel: 0.5,
    });
    const proposal = await createRecruitmentProposal(otherCtx, proposalInput(capability.id));
    await requestRecruitmentApproval(otherCtx, { proposalId: proposal.id });

    const stranger = member(tenantIsolation);
    await expectCode('proposal_not_found', () =>
      getRecruitmentProposal(stranger, { proposalId: proposal.id }),
    );
    await expectCode('proposal_not_found', () =>
      settleRecruitmentProposal(stranger, { proposalId: proposal.id }),
    );
    await expectCode('proposal_not_found', () =>
      requestRecruitmentApproval(stranger, { proposalId: proposal.id }),
    );
    await expectCode('proposal_not_found', () =>
      withdrawRecruitmentProposal(stranger, { proposalId: proposal.id, reason: 'x' }),
    );
    expect(await listRecruitmentProposals(stranger, {})).toEqual([]);
    expect(await listRecruitmentProposals(stranger, { status: 'awaiting_approval' })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Storage-level immutability
// ---------------------------------------------------------------------------

describe('storage-level immutability (migration 001 triggers)', () => {
  it('rejects substantive rewrites and erasure at the SQL layer', async () => {
    const ctx = member(tenantStorage);
    const capability = await capabilityWithGap(ctx, 'Churn-risk outreach', { requirementLevel: 0.5 });
    const proposal = await createRecruitmentProposal(ctx, proposalInput(capability.id));
    const alternativeId = proposal.alternatives[0]!.id;

    const db = getDb();
    // Substantive proposal rewrites are forbidden.
    await expect(
      db.query(`UPDATE agent_recruitment_proposals SET title = 'hacked' WHERE id = $1`, [proposal.id]),
    ).rejects.toThrow(/immutable history/);
    await expect(
      db.query(`UPDATE agent_recruitment_proposals SET rationale = 'hacked' WHERE id = $1`, [proposal.id]),
    ).rejects.toThrow(/immutable history/);
    await expect(
      db.query(`UPDATE agent_recruitment_proposals SET evidence_observation_ids = '[]'::jsonb WHERE id = $1`, [
        proposal.id,
      ]),
    ).rejects.toThrow(/immutable history/);
    // The alternatives are fully immutable.
    await expect(
      db.query(`UPDATE agent_recruitment_alternatives SET summary = 'hacked' WHERE id = $1`, [alternativeId]),
    ).rejects.toThrow(/immutable history/);
    await expect(
      db.query(`UPDATE agent_recruitment_alternatives SET recommended = true WHERE id = $1`, [alternativeId]),
    ).rejects.toThrow(/immutable history/);
    // Nothing is ever erased.
    await expect(
      db.query(`DELETE FROM agent_recruitment_proposals WHERE id = $1`, [proposal.id]),
    ).rejects.toThrow(/cannot be erased/);
    await expect(
      db.query(`DELETE FROM agent_recruitment_alternatives WHERE id = $1`, [alternativeId]),
    ).rejects.toThrow(/immutable history/);
    await expect(db.query(`TRUNCATE agent_recruitment_alternatives`)).rejects.toThrow(
      /immutable history/,
    );
    // Truncating the referenced table is rejected too (the FK fires before
    // the guard trigger — rejected is rejected, nothing is erased).
    await expect(db.query(`TRUNCATE agent_recruitment_proposals`)).rejects.toThrow(
      /cannot be erased|cannot truncate/,
    );

    // The lifecycle state itself DID move through the service (the guard
    // permits exactly that): submit and verify the row advanced.
    const submitted = await requestRecruitmentApproval(ctx, { proposalId: proposal.id });
    expect(submitted.status).toBe('awaiting_approval');
  });
});
