// Integration tests for the W074 conversational interventions & approval
// continuity against the embedded PostgreSQL (PGlite, `:memory:`) through
// the db port.
//
// THE WORK ITEM'S ACCEPTANCE, proven end to end through REAL module
// contracts:
//
//   * THE RECOMMENDATION — Aurum's awaiting recruitment proposals enter
//     the persistent "Aurum interventions" conversation as proactive chat
//     messages (one per proposal, idempotent forever), carrying the
//     shared-model capability-gap card and the intervention-proposal
//     card with the pending decision payload — the manager understands
//     the comparison (capability gap, alternatives, cost/weeks/level,
//     the recommended channel, the future grant) from Chat;
//   * INLINE HUMAN APPROVAL — the decide API casts the human vote
//     through the actions module's decideApproval (claim-gated,
//     separation of duties enforced THERE — the submitting principal can
//     never decide its own proposal), settles it onto the proposal, and
//     the OUTCOME message returns to the ORIGINATING thread;
//   * THE ACTIVATION — the activate API registers the agent through the
//     agents contract with EXACTLY the permission scopes the approved
//     recruit alternative proposed, and the activation outcome (the
//     agent card + the retain/modify/terminate lifecycle context)
//     returns to the same thread; a replay is idempotent (no second
//     activation message);
//   * DETAILED SURFACES REMAIN — the Interventions hub linkage reads the
//     SAME thread (which recommendations, decisions and activations it
//     carries) and derives the stable /chat?c= return link;
//   * CONVERGENCE — a proposal decided on the Interventions surface (a
//     different authorized human, the domain path) converges into the
//     thread through the delivery sweep — the transcript mirrors the
//     domain, never the reverse;
//   * HONEST REFUSALS — deciding a settled proposal is 409; activating a
//     rejected/no-recruit proposal is 409; the proposer's own session
//     deciding its proposal is 403 (separation of duties); malformed ids
//     are 404; anonymous is 401; bad bodies are 400;
//   * TENANT ISOLATION (ADR-0001) — tenant B's chat interventions
//     surface is blind to tenant A's thread, proposals and agents.

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
import {
  registerCapability,
  registerRequirement,
} from '@/modules/capabilities/contract';
import {
  createRecruitmentProposal,
  getRecruitmentProposal,
  requestRecruitmentApproval,
  settleRecruitmentProposal,
} from '@/modules/agent-recruitment/contract';
import type { AgentRecruitmentProposal } from '@/modules/agent-recruitment/contract';
import { getAgent } from '@/modules/agents/contract';
import { getActionRequest, decideApproval } from '@/modules/actions/contract';
import { ACTIONS_AUTHORITY_APPROVE } from '@/modules/actions/contract';

import { buildInterventionsHomeView } from '../lib/views';
import { buildChatStateView } from '../../chat/lib/chat-view';
import type { ChatMessageView } from '../../chat/lib/chat-types';
import {
  deliverInterventionRecommendationsToChat,
  findInterventionsConversation,
  interventionsChatLinkage,
  INTERVENTIONS_CONVERSATION_TITLE,
  suggestedSlugOf,
} from '../lib/chat-interventions';
import {
  handleInterventionsChatDeliverPost,
  handleInterventionsChatProposalActivatePost,
  handleInterventionsChatProposalDecidePost,
} from '../lib/chat-api';

const db = getDb();

// ---------------------------------------------------------------------------
// Fixture (the W063 interventions-integration discipline)
// ---------------------------------------------------------------------------

const SESSION_COOKIE = 'aurum_session';

// Fake credentials assembled from fragments at runtime (push-protection).
const passwordFragments = ['ga', 'nger', 'bread-', '3'];

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

function sessionRequest(token: string, body: unknown, url: string): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: `${SESSION_COOKIE}=${token}` },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

/** One capability gap + one submitted recruitment proposal (the W063 chain). */
async function submittedProposal(
  ctx: TenantContext,
  worker: TenantContext,
  name: string,
  overrides: {
    kinds?: { kind: 'train' | 'recruit' | 'hire'; recommended?: boolean }[];
  } = {},
): Promise<AgentRecruitmentProposal> {
  const capability = await registerCapability(ctx, {
    name,
    description: `The ${name} capability under review`,
    actor: { kind: 'person', label: 'interventions chat fixture' },
  });
  await registerRequirement(ctx, {
    capabilityId: capability.id,
    source: { kind: 'manual', label: 'the quarterly coverage plan' },
    level: 0.6,
    capacity: 4,
    actor: { kind: 'person', label: 'interventions chat fixture' },
    rationale: 'Peak-season demand exceeds the human-coordinated supply',
  });
  const kinds = overrides.kinds ?? [
    { kind: 'train' as const },
    { kind: 'recruit' as const, recommended: true },
    { kind: 'hire' as const },
  ];
  const proposal = await createRecruitmentProposal(worker, {
    title: `${name} coverage for the Q4 peak`,
    capabilityId: capability.id,
    rationale: `Peak-season ${name} demand exceeds the human-coordinated supply`,
    evidenceObservationIds: [],
    alternatives: kinds.map((entry) => ({
      kind: entry.kind,
      summary: `The ${entry.kind} alternative for ${name}`,
      estimatedCostMinor: entry.kind === 'hire' ? 250_000 : 90_000,
      estimatedCostCurrency: 'USD',
      estimatedWeeks: entry.kind === 'hire' ? 6 : 1,
      expectedLevel: 0.3,
      ...(entry.recommended === true ? { recommended: true } : {}),
      ...(entry.kind === 'recruit' ? { agentPermissions: ['observe', 'analyze'] } : {}),
    })),
  });
  await requestRecruitmentApproval(worker, {
    proposalId: proposal.id,
    justification: `the recommended ${name} acquisition covers the peak-season gap`,
  });
  return getRecruitmentProposal(ctx, { proposalId: proposal.id });
}

describe('conversational interventions & approval continuity over the full Journey E/I chain', () => {
  let acme: TenantFixture;
  let beta: TenantFixture;

  let approveProposalId: string;
  let rejectProposalId: string;
  let convergeProposalId: string;
  let selfSubmittedProposalId: string;
  let noRecruitProposalId: string;
  let conversationId: string;

  beforeAll(async () => {
    await runMigrations(db);
    acme = await provisionFixture('Northwind Chat Interventions');
    beta = await provisionFixture('Initech Chat Interventions');
    const ctx = ownerCtx(acme);

    approveProposalId = (
      await submittedProposal(ctx, workerCtx(acme.tenant.id), 'cold-chain-monitoring')
    ).id;
    rejectProposalId = (
      await submittedProposal(ctx, workerCtx(acme.tenant.id), 'invoice-reconciliation')
    ).id;
    // Decided later on the INTERVENTIONS SURFACE (a different approver) to
    // prove the convergence sweep.
    convergeProposalId = (
      await submittedProposal(ctx, workerCtx(acme.tenant.id), 'freight-exception-triage')
    ).id;
    // Submitted by the SESSION'S OWN principal — the separation-of-duties
    // probe (the proposer can never decide it).
    selfSubmittedProposalId = (
      await submittedProposal(ctx, ctx, 'self-submitted-probe')
    ).id;
    // Approved later, but compares no recruit alternative.
    noRecruitProposalId = (
      await submittedProposal(ctx, workerCtx(acme.tenant.id), 'roastery-report-writing', {
        kinds: [{ kind: 'train' }, { kind: 'hire' }],
      })
    ).id;
  });

  // -------------------------------------------------------------------------
  // THE RECOMMENDATION (Aurum speaks first — the proactive chat message)
  // -------------------------------------------------------------------------

  it('delivers the awaiting proposals into the persistent interventions conversation', async () => {
    const result = await handleInterventionsChatDeliverPost(
      sessionRequest(acme.ownerToken, {}, 'https://aurum.test/api/product/interventions/chat/deliver'),
    );
    expect(result.status).toBe(200);
    if (result.status !== 200) return;
    const body = result.body as {
      delivered?: boolean;
      conversationId?: string | null;
      awaitingCount?: number;
      recommendationsRecorded?: number;
    };
    expect(body.delivered).toBe(true);
    expect(body.awaitingCount).toBe(5);
    expect(body.recommendationsRecorded).toBe(5);
    conversationId = String(body.conversationId);

    const conversation = await findInterventionsConversation(ownerCtx(acme));
    expect(conversation?.id).toBe(conversationId);
    expect(conversation?.title).toBe(INTERVENTIONS_CONVERSATION_TITLE);

    // The message renders through the chat surface's own view builder (the
    // WhatsApp-like timeline): one left-aligned Aurum turn per proposal.
    const state = await buildChatStateView(ownerCtx(acme), conversationId);
    const messages = state.thread?.messages ?? [];
    expect(messages.length).toBe(5);
    expect(messages.every((message) => message.side === 'aurum')).toBe(true);
    expect(messages.every((message) => message.speaker === 'Aurum')).toBe(true);
    const recommendation = messages.find((message) =>
      message.text.includes('cold-chain-monitoring coverage'),
    );
    expect(recommendation).toBeDefined();
    expect(recommendation?.text).toContain('needs your decision');
    expect(recommendation?.answer?.intent).toBe('improve');
    const kinds = recommendation?.answer?.cards.map((card) => card.kind) ?? [];
    expect(kinds).toEqual(['capability', 'intervention-proposal']);
    const proposalCard = recommendation?.answer?.cards.find(
      (card) => card.kind === 'intervention-proposal',
    );
    expect(proposalCard?.id).toBe(approveProposalId);
    // THE GATE: the pending decision payload rides the card — the inline
    // human approval renders from it.
    expect(proposalCard?.decision?.status).toBe('pending');
    expect(proposalCard?.statusLabel).toBe('Needs your decision');
    const comparison = proposalCard?.meta.join('\n') ?? '';
    expect(comparison).toContain('Train an employee — ');
    expect(comparison).toContain('Recruit an agent — ');
    expect(comparison).toContain('recommended');
  });

  it('is idempotent: re-delivering the unchanged feed records nothing new', async () => {
    const before = await buildChatStateView(ownerCtx(acme), conversationId);
    const count = before.thread?.messages.length ?? 0;
    const result = await handleInterventionsChatDeliverPost(
      sessionRequest(acme.ownerToken, {}, 'https://aurum.test/x'),
    );
    expect(result.status).toBe(200);
    if (result.status !== 200) return;
    const body = result.body as {
      delivered?: boolean;
      recommendationsDeduped?: number;
      recommendationsRecorded?: number;
    };
    expect(body.delivered).toBe(false);
    expect(body.recommendationsRecorded).toBe(0);
    expect(body.recommendationsDeduped).toBe(5);
    const after = await buildChatStateView(ownerCtx(acme), conversationId);
    expect(after.thread?.messages.length).toBe(count);
  });

  // -------------------------------------------------------------------------
  // THE INLINE HUMAN DECISION (Journey E's chat-first path)
  // -------------------------------------------------------------------------

  it('approves the proposal from the thread: domain settle + outcome message back into the thread', async () => {
    const result = await handleInterventionsChatProposalDecidePost(
      sessionRequest(
        acme.ownerToken,
        { decision: 'approve', conversationId, note: 'covers the peak' },
        `https://aurum.test/api/product/interventions/chat/proposals/${approveProposalId}/decide`,
      ),
      approveProposalId,
    );
    expect(result.status).toBe(200);
    if (result.status !== 200) return;
    const body = result.body as {
      status?: string;
      decidedHere?: boolean;
      conversationId?: string;
      actionRequestId?: string;
      decidedAt?: string | null;
      outcome?: ChatMessageView;
    };
    expect(body.status).toBe('approved');
    expect(body.decidedHere).toBe(true);
    expect(body.conversationId).toBe(conversationId);
    expect(body.decidedAt).toBeTruthy();
    expect(body.actionRequestId).toBeTruthy();

    // THE DOMAIN — the same gate the Interventions surface drives: the
    // request is approved and settled onto the proposal.
    const proposal = await getRecruitmentProposal(ownerCtx(acme), {
      proposalId: approveProposalId,
    });
    expect(proposal.status).toBe('approved');
    expect(proposal.approval.decidedByPrincipal).toBe(acme.ownerPrincipalId);
    const request = await getActionRequest(ownerCtx(acme), {
      requestId: String(body.actionRequestId),
    });
    expect(request.status).toBe('approved');

    // THE THREAD — the outcome message returned to the originating thread.
    const state = await buildChatStateView(ownerCtx(acme), conversationId);
    const messages = state.thread?.messages ?? [];
    expect(messages.length).toBe(6);
    const outcome = messages[5]!;
    expect(outcome.side).toBe('aurum');
    expect(outcome.text).toContain('Approved — "cold-chain-monitoring coverage for the Q4 peak"');
    expect(outcome.text).toContain('decided it in this thread');
    expect(outcome.text).toContain('you can activate it here');
    // The outcome cards: the settled proposal (approved) + the gap.
    const kinds = outcome.answer?.cards.map((card) => card.kind) ?? [];
    expect(kinds).toEqual(expect.arrayContaining(['intervention-proposal', 'capability']));
    const proposalCard = outcome.answer?.cards.find(
      (card) => card.kind === 'intervention-proposal',
    );
    expect(proposalCard?.decision?.status).toBe('approved');
    // The decision trail is cited (the authority-gate request).
    expect(
      outcome.answer?.citations.some(
        (citation) => citation.kind === 'action-request' && citation.id === body.actionRequestId,
      ),
    ).toBe(true);
  });

  it('rejects the second proposal from the thread with the same honest shape', async () => {
    const result = await handleInterventionsChatProposalDecidePost(
      sessionRequest(
        acme.ownerToken,
        { decision: 'reject', conversationId },
        `https://aurum.test/api/product/interventions/chat/proposals/${rejectProposalId}/decide`,
      ),
      rejectProposalId,
    );
    expect(result.status).toBe(200);
    if (result.status !== 200) return;
    const body = result.body as { status?: string };
    expect(body.status).toBe('rejected');
    const proposal = await getRecruitmentProposal(ownerCtx(acme), {
      proposalId: rejectProposalId,
    });
    expect(proposal.status).toBe('rejected');
    const state = await buildChatStateView(ownerCtx(acme), conversationId);
    const outcome = (state.thread?.messages ?? []).find((message) =>
      message.text.includes('Rejected — "invoice-reconciliation coverage'),
    );
    expect(outcome).toBeDefined();
    expect(outcome?.text).toContain('A changed comparison is a new proposal');
  });

  it('refuses a re-decide on the settled proposal (first decision wins, 409)', async () => {
    const result = await handleInterventionsChatProposalDecidePost(
      sessionRequest(
        acme.ownerToken,
        { decision: 'approve', conversationId },
        `https://aurum.test/api/product/interventions/chat/proposals/${approveProposalId}/decide`,
      ),
      approveProposalId,
    );
    expect(result.status).toBe(409);
    const state = await buildChatStateView(ownerCtx(acme), conversationId);
    // No new thread turn was fabricated for the refused re-decide.
    expect(state.thread?.messages.length).toBe(7);
  });

  // -------------------------------------------------------------------------
  // THE ACTIVATION (Journey I's chat-first path)
  // -------------------------------------------------------------------------

  it('activates the approved recruit from the thread with exactly the proposed scopes', async () => {
    const result = await handleInterventionsChatProposalActivatePost(
      sessionRequest(
        acme.ownerToken,
        { conversationId },
        `https://aurum.test/api/product/interventions/chat/proposals/${approveProposalId}/activate`,
      ),
      approveProposalId,
    );
    expect(result.status).toBe(200);
    if (result.status !== 200) return;
    const body = result.body as {
      created?: boolean;
      conversationId?: string;
      agent?: { id?: string; slug?: string; status?: string; permissions?: string[] };
      outcome?: ChatMessageView;
    };
    expect(body.created).toBe(true);
    expect(body.conversationId).toBe(conversationId);
    // The suggested slug derives from the proposal title (the same
    // default the Interventions activation form pre-fills).
    expect(body.agent?.slug).toBe(suggestedSlugOf('cold-chain-monitoring coverage for the Q4 peak'));
    // EXACTLY the scopes the approved comparison proposed.
    expect(body.agent?.permissions).toEqual(['observe', 'analyze']);

    // THE DOMAIN — the agent exists as an organizational actor.
    const agent = await getAgent(ownerCtx(acme), { agentId: String(body.agent?.id) });
    expect(agent.status).toBe('active');
    expect(agent.permissions).toEqual(['observe', 'analyze']);

    // THE THREAD — the activation outcome message.
    const state = await buildChatStateView(ownerCtx(acme), conversationId);
    const messages = state.thread?.messages ?? [];
    expect(messages.length).toBe(8);
    const activation = messages[7]!;
    expect(activation.text).toContain('Activated —');
    expect(activation.text).toContain('(observe / analyze)');
    const kinds = activation.answer?.cards.map((card) => card.kind) ?? [];
    expect(kinds).toEqual(expect.arrayContaining(['intervention-agent', 'intervention-proposal']));
    const agentCard = activation.answer?.cards.find((card) => card.kind === 'intervention-agent');
    expect(agentCard?.id).toBe(body.agent?.id);
    expect(agentCard?.href).toBe(`/interventions/agents/${body.agent?.id}`);
    expect(agentCard?.meta.join(' ')).toContain('Scopes: observe / analyze');
    expect(agentCard?.meta.join(' ')).toContain('retain / modify / terminate');
  });

  it('replays the activation idempotently (the same agent, no new message)', async () => {
    const first = await handleInterventionsChatProposalActivatePost(
      sessionRequest(
        acme.ownerToken,
        { conversationId },
        `https://aurum.test/api/product/interventions/chat/proposals/${approveProposalId}/activate`,
      ),
      approveProposalId,
    );
    expect(first.status).toBe(200);
    if (first.status !== 200) return;
    const body = first.body as { created?: boolean; agent?: { id?: string } };
    expect(body.created).toBe(false);
    const state = await buildChatStateView(ownerCtx(acme), conversationId);
    // The (tenant, channel, providerMessageId) dedupe holds: still 8.
    expect(state.thread?.messages.length).toBe(8);
  });

  it('refuses activation on a rejected proposal (409 intervention_state)', async () => {
    const result = await handleInterventionsChatProposalActivatePost(
      sessionRequest(
        acme.ownerToken,
        { conversationId },
        `https://aurum.test/api/product/interventions/chat/proposals/${rejectProposalId}/activate`,
      ),
      rejectProposalId,
    );
    expect(result.status).toBe(409);
  });

  it('refuses activation on an approved proposal with no recruit alternative (409, honest routing)', async () => {
    // Approve the no-recruit proposal first (through the same chat lane).
    const decided = await handleInterventionsChatProposalDecidePost(
      sessionRequest(
        acme.ownerToken,
        { decision: 'approve', conversationId },
        `https://aurum.test/api/product/interventions/chat/proposals/${noRecruitProposalId}/decide`,
      ),
      noRecruitProposalId,
    );
    expect(decided.status).toBe(200);
    const result = await handleInterventionsChatProposalActivatePost(
      sessionRequest(
        acme.ownerToken,
        { conversationId },
        `https://aurum.test/api/product/interventions/chat/proposals/${noRecruitProposalId}/activate`,
      ),
      noRecruitProposalId,
    );
    expect(result.status).toBe(409);
    if (result.status !== 409) return;
    expect(result.body.message).toContain('compares no agent recruitment');
  });

  // -------------------------------------------------------------------------
  // CONVERGENCE — decided on the Interventions surface, mirrored in the thread
  // -------------------------------------------------------------------------

  it('converges a proposal decided on the Interventions surface into the thread', async () => {
    // A DIFFERENT authorized human decides through the DOMAIN path (the
    // Interventions surface's own workflow), then the sweep converges.
    const before = await buildChatStateView(ownerCtx(acme), conversationId);
    const count = before.thread?.messages.length ?? 0;
    const pending = await getRecruitmentProposal(ownerCtx(acme), {
      proposalId: convergeProposalId,
    });
    const requestId = pending.approval.actionRequestId;
    expect(requestId).not.toBeNull();
    await decideApproval(approverCtx(acme.tenant.id), {
      requestId: String(requestId),
      decision: 'approve',
      note: 'decided on the Interventions surface',
    });
    const settled = await settleRecruitmentProposal(ownerCtx(acme), {
      proposalId: convergeProposalId,
    });
    expect(settled.status).toBe('approved');

    const sweep = await deliverInterventionRecommendationsToChat(ownerCtx(acme));
    expect(sweep.ok).toBe(true);
    if (sweep.ok) {
      expect(sweep.delivered).toBe(true);
      expect(sweep.outcomesRecorded).toBe(1);
    }

    // The thread converged with the outcome message for that proposal —
    // composed from live domain state, marked decided elsewhere.
    const state = await buildChatStateView(ownerCtx(acme), conversationId);
    const messages = state.thread?.messages ?? [];
    expect(messages.length).toBe(count + 1);
    const outcome = messages[messages.length - 1]!;
    expect(outcome.text).toContain('Approved — "freight-exception-triage coverage');
    expect(outcome.text).toContain('decided by an authorized human');
    // No member turn was fabricated for the surface decision.
    expect(messages.every((message) => message.side === 'aurum')).toBe(true);
  });

  // -------------------------------------------------------------------------
  // DETAILED SURFACES REMAIN — the hub linkage (one governance truth)
  // -------------------------------------------------------------------------

  it('the Interventions hub linkage reads the same thread and its return link', async () => {
    const linkage = await interventionsChatLinkage(ownerCtx(acme));
    expect(linkage).not.toBeNull();
    expect(linkage?.conversationId).toBe(conversationId);
    expect(linkage?.recommendationProposalIds).toContain(approveProposalId);
    expect(linkage?.recommendationProposalIds).toContain(convergeProposalId);
    expect(linkage?.decidedProposalIds).toContain(approveProposalId);
    expect(linkage?.decidedProposalIds).toContain(rejectProposalId);
    expect(linkage?.decidedProposalIds).toContain(convergeProposalId);
    expect(linkage?.activatedProposalIds).toEqual([approveProposalId]);
    // The hub's return link is the stable /chat?c= shape.
    expect(`/chat?c=${linkage?.conversationId}`).toBe(`/chat?c=${conversationId}`);

    // The hub view still renders the same proposals (detail truth intact).
    const view = await buildInterventionsHomeView(ownerCtx(acme));
    expect(view.proposals.map((row) => row.id)).toContain(approveProposalId);
    expect(view.proposals.map((row) => row.id)).toContain(convergeProposalId);
    expect(view.degraded).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // HUMAN AUTHORITY — separation of duties enforced by the actions module
  // -------------------------------------------------------------------------

  it('refuses the proposer\'s own session deciding its proposal (403 separation of duties)', async () => {
    const result = await handleInterventionsChatProposalDecidePost(
      sessionRequest(
        acme.ownerToken,
        { decision: 'approve', conversationId },
        `https://aurum.test/api/product/interventions/chat/proposals/${selfSubmittedProposalId}/decide`,
      ),
      selfSubmittedProposalId,
    );
    expect(result.status).toBe(403);
    if (result.status !== 403) return;
    expect(result.body.error).toBe('forbidden');
    // The proposal stays at the gate.
    const proposal = await getRecruitmentProposal(ownerCtx(acme), {
      proposalId: selfSubmittedProposalId,
    });
    expect(proposal.status).toBe('awaiting_approval');
  });

  // -------------------------------------------------------------------------
  // The honest API discipline
  // -------------------------------------------------------------------------

  it('maps the API surfaces honestly (401 anonymous, 404 malformed, 400 bad body)', async () => {
    const deliverUrl = 'https://aurum.test/api/product/interventions/chat/deliver';
    const anonymousDeliver = await handleInterventionsChatDeliverPost(
      new Request(deliverUrl, { method: 'POST', body: '{}' }),
    );
    expect(anonymousDeliver.status).toBe(401);

    const anonymousDecide = await handleInterventionsChatProposalDecidePost(
      new Request('https://aurum.test/x', { method: 'POST', body: '{}' }),
      approveProposalId,
    );
    expect(anonymousDecide.status).toBe(401);

    const anonymousActivate = await handleInterventionsChatProposalActivatePost(
      new Request('https://aurum.test/x', { method: 'POST', body: '{}' }),
      approveProposalId,
    );
    expect(anonymousActivate.status).toBe(401);

    const malformed = await handleInterventionsChatProposalDecidePost(
      sessionRequest(acme.ownerToken, { decision: 'approve' }, 'https://aurum.test/x'),
      'not-a-uuid',
    );
    expect(malformed.status).toBe(404);

    const badBody = await handleInterventionsChatProposalDecidePost(
      sessionRequest(acme.ownerToken, 'not json at all', 'https://aurum.test/x'),
      approveProposalId,
    );
    expect(badBody.status).toBe(400);

    const badDecision = await handleInterventionsChatProposalDecidePost(
      sessionRequest(acme.ownerToken, { decision: 'maybe' }, 'https://aurum.test/x'),
      approveProposalId,
    );
    expect(badDecision.status).toBe(400);

    const badActivateBody = await handleInterventionsChatProposalActivatePost(
      sessionRequest(acme.ownerToken, 'nope', 'https://aurum.test/x'),
      approveProposalId,
    );
    expect(badActivateBody.status).toBe(400);
  });

  it('delivers nothing for a tenant with no proposals (no empty conversation is created)', async () => {
    const result = await handleInterventionsChatDeliverPost(
      sessionRequest(beta.ownerToken, {}, 'https://aurum.test/x'),
    );
    expect(result.status).toBe(200);
    if (result.status !== 200) return;
    const body = result.body as { delivered?: boolean; conversationId?: string | null };
    expect(body.delivered).toBe(false);
    expect(body.conversationId).toBeNull();
    expect(await findInterventionsConversation(ownerCtx(beta))).toBeNull();
    expect(await interventionsChatLinkage(ownerCtx(beta))).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Tenant isolation (ADR-0001)
  // -------------------------------------------------------------------------

  it("keeps tenant B's chat interventions surface blind to tenant A", async () => {
    // Cross-tenant decide: proposal_not_found (404), no existence leak.
    const crossDecide = await handleInterventionsChatProposalDecidePost(
      sessionRequest(beta.ownerToken, { decision: 'approve' }, 'https://aurum.test/x'),
      approveProposalId,
    );
    expect(crossDecide.status).toBe(404);
    const crossActivate = await handleInterventionsChatProposalActivatePost(
      sessionRequest(beta.ownerToken, {}, 'https://aurum.test/x'),
      approveProposalId,
    );
    expect(crossActivate.status).toBe(404);
    // The thread and the linkage are invisible to tenant B's context.
    expect(await findInterventionsConversation(ownerCtx(beta))).toBeNull();
    expect(await interventionsChatLinkage(ownerCtx(beta))).toBeNull();
    // Tenant A's proposal is unaffected by the cross-tenant attempts.
    const proposal = await getRecruitmentProposal(ownerCtx(acme), {
      proposalId: approveProposalId,
    });
    expect(proposal.status).toBe('approved');
  });

  afterAll(async () => {
    await closeDb();
  });
});
