// Unit tests for the W074 conversational interventions & approval
// continuity's PURE layer — no DB, no DOM: the provider-message idempotency
// keys, the shared-contract intervention card kinds (the payload guards
// accept them — renderer parity for stored payloads), the
// recommendation/decision/activation payload composition (cards,
// decision payloads, citations, safeguard context), the conversational
// comparison copy, the suggested activation derivation, the stable
// /chat?c= return-link shape, the API body parsing, and the error
// mapping — the acceptance's presentation clauses, pinned here.

import { describe, expect, it } from 'vitest';
import type {
  AgentRecruitmentProposal,
  RecruitmentAlternative,
} from '@/modules/agent-recruitment/contract';
import type { AgentDefinition } from '@/modules/agents/contract';
import {
  activationProviderMessageId,
  capabilityGapCard,
  comparisonLine,
  comparisonLines,
  interventionProposalCard,
  interventionsChatHref,
  INTERVENTIONS_CONVERSATION_TITLE,
  INTERVENTION_ACTIVATION_PREFIX,
  INTERVENTION_OUTCOME_PREFIX,
  INTERVENTION_REC_PREFIX,
  outcomeProviderMessageId,
  proposalCitations,
  proposalStatusLabelChat,
  recommendationAnswer,
  recommendationProviderMessageId,
  renderActivationText,
  renderOutcomeText,
  renderRecommendationText,
  suggestedSlugOf,
  activationAnswer,
  outcomeAnswer,
  type InterventionsChatLinkage,
} from '../lib/chat-interventions';
import {
  parseChatProposalActivationBody,
  parseChatProposalDecisionBody,
  interventionsChatApiError,
} from '../lib/chat-api';
import { InterventionStateError } from '../lib/workflow';
import { ActionsError } from '@/modules/actions/contract';
import { AgentRecruitmentError } from '@/modules/agent-recruitment/contract';
import {
  parseTurnPayload,
  normalizeChatCard,
  fallbackCardContext,
  chatConversationHref,
  CHAT_CARD_KINDS,
  INTERVENTION_CARD_KINDS,
  isInterventionCardKind,
  isChatCardKind,
} from '../../chat/lib/chat-types';

// ---------------------------------------------------------------------------
// Fixtures (plain domain-shaped objects — the pure builders read only)
// ---------------------------------------------------------------------------

const PROPOSAL_ID = '11111111-1111-4111-8111-111111111111';
const CAPABILITY_ID = '22222222-2222-4222-8222-222222222222';
const REQUEST_ID = '33333333-3333-4333-8333-333333333333';
const OBSERVATION_ID = '44444444-4444-4444-8444-444444444444';
const AGENT_ID = '55555555-5555-4555-8555-555555555555';

function alternative(
  kind: RecruitmentAlternative['kind'],
  overrides: Partial<RecruitmentAlternative> = {},
): RecruitmentAlternative {
  return {
    id: `alt-${kind}`,
    tenantId: 'tenant-1',
    proposalId: PROPOSAL_ID,
    kind,
    summary: `The ${kind} alternative`,
    note: null,
    estimatedCostMinor: 90_000,
    estimatedCostCurrency: 'USD',
    estimatedWeeks: 1,
    expectedLevel: 0.3,
    expectedCapacity: null,
    recommended: false,
    agentPermissions: null,
    impliedAuthorityLevel: null,
    ...overrides,
  };
}

const ALTERNATIVES: RecruitmentAlternative[] = [
  alternative('train', {
    estimatedCostMinor: 40_000,
    estimatedWeeks: 4,
    expectedLevel: 0.15,
    recommended: false,
  }),
  alternative('recruit', {
    recommended: true,
    agentPermissions: ['observe', 'analyze'],
    impliedAuthorityLevel: 'PROPOSE',
  }),
  alternative('hire', {
    estimatedCostMinor: 250_000,
    estimatedWeeks: 6,
    expectedLevel: 0.25,
  }),
];

function proposal(
  overrides: Partial<AgentRecruitmentProposal> = {},
): AgentRecruitmentProposal {
  const base: AgentRecruitmentProposal = {
    id: PROPOSAL_ID,
    tenantId: 'tenant-1',
    title: 'Cold-chain coverage for the Q4 peak',
    status: 'awaiting_approval',
    capability: {
      capabilityId: CAPABILITY_ID,
      capabilityName: 'cold-chain-monitoring',
      capabilityStatus: 'active',
      gapStatus: 'capacity_shortfall',
      bestActiveLevel: 0.4,
      totalActiveCapacity: 2,
    },
    rationale:
      'Peak-season cold-chain demand exceeds the human-coordinated supply; the freshness goal depends on closing the gap',
    evidenceObservationIds: [OBSERVATION_ID],
    alternatives: ALTERNATIVES,
    recommendation: ALTERNATIVES[1]!,
    approval: {
      actionRequestId: REQUEST_ID,
      policyOutcome: 'approval_required',
      policyResolvedVia: 'built-in',
      submittedBy: 'worker-1',
      submittedAt: '2026-09-22T08:00:00.000Z',
      decidedBy: null,
      decidedByPrincipal: null,
      decidedAt: null,
    },
    createdBy: 'worker-1',
    createdAt: '2026-09-22T08:00:00.000Z',
    updatedAt: '2026-09-22T08:00:00.000Z',
    withdrawnAt: null,
    withdrawalReason: null,
  };
  return { ...base, ...overrides };
}

function agent(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  const base: AgentDefinition = {
    id: AGENT_ID,
    tenantId: 'tenant-1',
    slug: 'cold-chain-coverage-for-the-q4-peak',
    displayName: 'Recruit a cold-chain monitoring agent from the governed marketplace',
    role: 'Recruit a cold-chain monitoring agent from the governed marketplace',
    description: null,
    provider: 'langgraph',
    instructions: 'Act on the approved recruitment proposal.',
    runtimeConfig: null,
    permissions: ['observe', 'analyze'],
    status: 'active',
    createdBy: 'owner-1',
    createdAt: '2026-09-22T09:00:00.000Z',
    updatedAt: '2026-09-22T09:00:00.000Z',
  };
  return { ...base, ...overrides };
}

// ---------------------------------------------------------------------------
// The idempotency keys
// ---------------------------------------------------------------------------

describe('the provider-message idempotency keys', () => {
  it('derives one stable key per proposal per message family', () => {
    expect(recommendationProviderMessageId(PROPOSAL_ID)).toBe(
      `${INTERVENTION_REC_PREFIX}${PROPOSAL_ID}`,
    );
    expect(outcomeProviderMessageId(PROPOSAL_ID)).toBe(
      `${INTERVENTION_OUTCOME_PREFIX}${PROPOSAL_ID}`,
    );
    expect(activationProviderMessageId(PROPOSAL_ID)).toBe(
      `${INTERVENTION_ACTIVATION_PREFIX}${PROPOSAL_ID}`,
    );
  });

  it('is deterministic: the same proposal always yields the same keys', () => {
    expect(recommendationProviderMessageId(PROPOSAL_ID)).toBe(
      recommendationProviderMessageId(PROPOSAL_ID),
    );
    expect(outcomeProviderMessageId(PROPOSAL_ID)).toBe(outcomeProviderMessageId(PROPOSAL_ID));
    expect(activationProviderMessageId(PROPOSAL_ID)).toBe(
      activationProviderMessageId(PROPOSAL_ID),
    );
  });
});

// ---------------------------------------------------------------------------
// The shared card contract (W072) — the W074 kinds join it, never fork it
// ---------------------------------------------------------------------------

describe('the intervention kinds join the shared card contract', () => {
  it('the unified model carries the two W074 station kinds', () => {
    expect([...INTERVENTION_CARD_KINDS]).toEqual(['intervention-proposal', 'intervention-agent']);
    for (const kind of INTERVENTION_CARD_KINDS) {
      expect(isChatCardKind(kind)).toBe(true);
      expect(CHAT_CARD_KINDS).toContain(kind);
    }
  });

  it('the guard admits the W074 kinds and nothing look-alike', () => {
    expect(isInterventionCardKind('intervention-proposal')).toBe(true);
    expect(isInterventionCardKind('intervention-agent')).toBe(true);
    expect(isInterventionCardKind('recommendation')).toBe(false);
    expect(isInterventionCardKind('intervention')).toBe(false);
    expect(isInterventionCardKind(42)).toBe(false);
  });

  it('the renderer degrades a stored intervention card with no context to the honest fallback', () => {
    // The renderer-parity guarantee: a stored payload (arbitrary JSON)
    // with the W074 kinds parses through the SAME guard and never
    // renders a context-less consequential card.
    const parsed = normalizeChatCard({
      kind: 'intervention-proposal',
      id: PROPOSAL_ID,
      title: 'Cold-chain coverage for the Q4 peak',
      statusLabel: 'Needs your decision',
      tone: 'warning',
      meta: [],
      href: `/interventions/proposals/${PROPOSAL_ID}`,
      decision: { requestId: REQUEST_ID, status: 'pending' },
      context: null,
    });
    expect(parsed).not.toBeNull();
    expect(parsed?.kind).toBe('intervention-proposal');
    expect(parsed?.decision?.status).toBe('pending');
    expect(parsed?.context).toEqual(fallbackCardContext('intervention-proposal'));

    const agentParsed = normalizeChatCard({
      kind: 'intervention-agent',
      id: AGENT_ID,
      title: 'Cold-chain monitor',
      statusLabel: 'active',
      tone: 'positive',
      meta: [],
    });
    expect(agentParsed).not.toBeNull();
    expect(agentParsed?.context).toEqual(fallbackCardContext('intervention-agent'));
  });

  it('the honest fallback states the kind semantics and links the truth surfaces', () => {
    const fallback = fallbackCardContext('intervention-proposal');
    expect(fallback.sections.length).toBeGreaterThan(0);
    expect(fallback.subtitle).toContain('owning surface is the source of truth');
    const agentFallback = fallbackCardContext('intervention-agent');
    const lines = agentFallback.sections.map((section) => section.lines.join(' ')).join(' ');
    expect(lines).toContain('organizational actor');
  });
});

// ---------------------------------------------------------------------------
// The payload composition (the pure builders)
// ---------------------------------------------------------------------------

describe('the recommendation payload composition', () => {
  it('carries the capability-gap card and the proposal card with the pending decision', () => {
    const answer = recommendationAnswer(proposal());
    expect(answer.intent).toBe('improve');
    expect(answer.mode).toBe('deterministic');
    const kinds = answer.cards.map((card) => card.kind);
    expect(kinds).toEqual(['capability', 'intervention-proposal']);
    const proposalCard = answer.cards[1]!;
    expect(proposalCard.id).toBe(PROPOSAL_ID);
    expect(proposalCard.href).toBe(`/interventions/proposals/${PROPOSAL_ID}`);
    // THE GATE: while awaiting approval the card carries the pending
    // decision payload — the inline human approval rides it.
    expect(proposalCard.decision).toEqual({ requestId: REQUEST_ID, status: 'pending' });
    expect(proposalCard.statusLabel).toBe('Needs your decision');
    expect(proposalCard.tone).toBe('warning');
    // The comparison, conversationally legible: one line per alternative.
    expect(proposalCard.meta.length).toBeGreaterThanOrEqual(1 + ALTERNATIVES.length);
    const comparison = proposalCard.meta.join('\n');
    expect(comparison).toContain('Train an employee — ');
    expect(comparison).toContain('Recruit an agent — ');
    expect(comparison).toContain('Hire human capability — ');
    expect(comparison).toContain('recommended');
  });

  it('the capability-gap card drills into the comparison (not the bare list)', () => {
    const card = capabilityGapCard(proposal());
    expect(card.kind).toBe('capability');
    expect(card.id).toBe(CAPABILITY_ID);
    expect(card.href).toBe(`/interventions/proposals/${PROPOSAL_ID}`);
    expect(card.linkLabel).toBe('Open the comparison');
    expect(card.meta.join(' ')).toContain('3 compared alternatives');
  });

  it('cites the evidence observations and the authority-gate request', () => {
    const citations = proposalCitations(proposal());
    expect(citations.some((c) => c.kind === 'observation' && c.id === OBSERVATION_ID)).toBe(true);
    expect(
      citations.some((c) => c.kind === 'action-request' && c.id === REQUEST_ID),
    ).toBe(true);
  });

  it('an approved proposal with a recruit alternative announces the activation', () => {
    const card = interventionProposalCard(
      proposal({ status: 'approved', approval: {
        actionRequestId: REQUEST_ID,
        policyOutcome: 'approval_required',
        policyResolvedVia: 'built-in',
        submittedBy: 'worker-1',
        submittedAt: '2026-09-22T08:00:00.000Z',
        decidedBy: 'principal',
        decidedByPrincipal: 'manager-1',
        decidedAt: '2026-09-22T10:00:00.000Z',
      } }),
    );
    expect(card.decision).toEqual({ requestId: REQUEST_ID, status: 'approved' });
    expect(card.statusLabel).toBe('Approved — activation available');
    expect(card.tone).toBe('positive');
  });

  it('a proposal without a gate request renders no decision payload', () => {
    const card = interventionProposalCard(
      proposal({ status: 'proposed', approval: {
        actionRequestId: null,
        policyOutcome: null,
        policyResolvedVia: null,
        submittedBy: null,
        submittedAt: null,
        decidedBy: null,
        decidedByPrincipal: null,
        decidedAt: null,
      } }),
    );
    expect(card.decision).toBeNull();
    expect(card.statusLabel).toBe('Draft — not at the gate');
  });

  it('the proposal card context carries the human authority gate as policy', () => {
    const card = interventionProposalCard(proposal());
    expect(card.context).not.toBeNull();
    const policy = card.context!.sections.find((section) => section.kind === 'policy');
    expect(policy).toBeDefined();
    const text = policy!.lines.join(' ');
    expect(text).toContain('authorized human decides');
    expect(text).toContain('Separation of duties');
    // The future grant is visible at decision time (lock 23): the
    // context drawer carries the proposed scopes.
    const grant = card.context!.sections.find((section) => section.kind === 'detail');
    expect(grant).toBeDefined();
    expect(grant!.lines.join(' ')).toContain('Proposed agent scopes: observe / analyze');
  });

  it('the comparison meta surfaces the recruit scopes when the recommended alternative is another kind', () => {
    const [train, recruit, hire] = ALTERNATIVES;
    const card = interventionProposalCard(
      proposal({
        alternatives: [train!, recruit!, hire!],
        recommendation: train!,
      }),
    );
    expect(card.meta.join('\n')).toContain('Proposed agent scopes: observe / analyze');
  });
});

describe('the outcome and activation payload composition', () => {
  it('the decision outcome carries the settled proposal card (approved, no pending gate)', () => {
    const settled = proposal({ status: 'approved' });
    const answer = outcomeAnswer(settled, true);
    expect(answer.headline).toContain('Approved');
    const proposalCard = answer.cards.find((card) => card.kind === 'intervention-proposal');
    expect(proposalCard?.decision?.status).toBe('approved');
    const rejectedAnswer = outcomeAnswer(
      proposal({ status: 'rejected' }),
      false,
    );
    expect(rejectedAnswer.headline).toContain('Rejected');
  });

  it('the activation outcome carries the agent card with its lifecycle context', () => {
    const answer = activationAnswer(agent(), proposal({ status: 'approved' }));
    const agentCard = answer.cards.find((card) => card.kind === 'intervention-agent');
    expect(agentCard).toBeDefined();
    expect(agentCard?.id).toBe(AGENT_ID);
    expect(agentCard?.href).toBe(`/interventions/agents/${AGENT_ID}`);
    expect(agentCard?.meta.join(' ')).toContain('Scopes: observe / analyze');
    expect(agentCard?.meta.join(' ')).toContain('retain / modify / terminate');
    const context = agentCard?.context;
    expect(context).not.toBeNull();
    const policy = context!.sections.find((section) => section.kind === 'policy');
    expect(policy).toBeDefined();
    expect(policy!.title).toContain('retain, modify, terminate');
    expect(policy!.lines.join(' ')).toContain('human-authorized');
    expect(policy!.lines.join(' ')).toContain('never autonomously terminates a human employee');
  });
});

// ---------------------------------------------------------------------------
// The conversational copy
// ---------------------------------------------------------------------------

describe('the conversational copy', () => {
  it('the recommendation text asks for the decision and points at the authority split', () => {
    const text = renderRecommendationText(proposal());
    expect(text).toContain('needs your decision');
    expect(text).toContain('cold-chain-monitoring');
    expect(text).toContain('3 ways to close the gap');
    expect(text).toContain('recommended alternative is recruit');
    expect(text).toContain('You can decide right here');
  });

  it('a proposal with no recommended alternative says so honestly', () => {
    const unrecommended = ALTERNATIVES.map((entry) => ({ ...entry, recommended: false }));
    const text = renderRecommendationText(
      proposal({ alternatives: unrecommended, recommendation: null }),
    );
    expect(text).toContain('no single alternative is recommended');
  });

  it('the approved outcome text names the decider and offers the activation when a recruit stands', () => {
    const text = renderOutcomeText(proposal({ status: 'approved' }), true, 'Northwind Owner');
    expect(text).toContain('Approved — "Cold-chain coverage for the Q4 peak"');
    expect(text).toContain('Northwind Owner decided it in this thread');
    expect(text).toContain('you can activate it here');
  });

  it('the approved outcome text routes a no-recruit approval to the Interventions surface', () => {
    const noRecruit = [alternative('train'), alternative('hire')];
    const text = renderOutcomeText(
      proposal({ status: 'approved', alternatives: noRecruit }),
      false,
      null,
    );
    expect(text).toContain('decided by an authorized human');
    expect(text).toContain('no agent recruitment');
    expect(text).toContain('activates on the Interventions surface');
  });

  it('the rejected outcome text states the first-decision-wins discipline', () => {
    const text = renderOutcomeText(proposal({ status: 'rejected' }), false, null);
    expect(text).toContain('Rejected — "Cold-chain coverage for the Q4 peak"');
    expect(text).toContain('A changed comparison is a new proposal');
  });

  it('the activation text names the agent, the exact scopes and the human lifecycle', () => {
    const text = renderActivationText(agent(), proposal({ status: 'approved' }), 'Northwind Owner');
    expect(text).toContain('Activated —');
    expect(text).toContain('exactly the scopes the approved comparison proposed (observe / analyze)');
    expect(text).toContain('Northwind Owner ran the activation');
    expect(text).toContain('retain, modify or terminate');
    expect(text).toContain('decided by humans');
  });
});

// ---------------------------------------------------------------------------
// The comparison line (the decision-time legibility seam)
// ---------------------------------------------------------------------------

describe('comparisonLine', () => {
  it('leads with the kind word, carries the dimensions and the recommendation flag', () => {
    const line = comparisonLine(ALTERNATIVES[1]!);
    expect(line).toMatch(/^Recruit an agent — /);
    expect(line).toContain('The recruit alternative');
    expect(line).toContain('900.00 USD');
    expect(line).toContain('1 week');
    expect(line).toContain('+30% level');
    expect(line).toContain('· recommended');
  });

  it('is honest when no estimates are recorded', () => {
    const bare = alternative('reassign', {
      summary: 'Move work to the Portland team',
      estimatedCostMinor: null,
      estimatedCostCurrency: null,
      estimatedWeeks: null,
      expectedLevel: null,
      expectedCapacity: null,
    });
    expect(comparisonLine(bare)).toContain('no estimates recorded');
  });

  it('comparisonLines maps every alternative in order', () => {
    expect(comparisonLines(ALTERNATIVES)).toHaveLength(3);
    expect(comparisonLines(ALTERNATIVES)[0]).toMatch(/^Train an employee — /);
  });
});

// ---------------------------------------------------------------------------
// The suggested activation + slug derivation
// ---------------------------------------------------------------------------

describe('suggestedSlugOf', () => {
  it('slugifies a proposal title', () => {
    expect(suggestedSlugOf('Cold-chain coverage for the Q4 peak!')).toBe(
      'cold-chain-coverage-for-the-q4-peak',
    );
  });

  it('falls back to a stable slug for unsalvageable titles', () => {
    expect(suggestedSlugOf('???')).toBe('recruited-agent');
    expect(suggestedSlugOf('')).toBe('recruited-agent');
  });

  it('bounds the slug length', () => {
    expect(suggestedSlugOf('a'.repeat(200)).length).toBeLessThanOrEqual(48);
  });
});

// ---------------------------------------------------------------------------
// The chat status label
// ---------------------------------------------------------------------------

describe('proposalStatusLabelChat', () => {
  it('maps every status to calm chat copy', () => {
    expect(proposalStatusLabelChat('awaiting_approval')).toBe('Needs your decision');
    expect(proposalStatusLabelChat('approved')).toBe('Approved');
    expect(proposalStatusLabelChat('rejected')).toBe('Rejected');
    expect(proposalStatusLabelChat('proposed')).toBe('Draft — not at the gate');
    expect(proposalStatusLabelChat('withdrawn')).toBe('Withdrawn');
  });
});

// ---------------------------------------------------------------------------
// The persistent thread's title and return link
// ---------------------------------------------------------------------------

describe('the interventions conversation linkage vocabulary', () => {
  it('the persistent thread title is stable and findable', () => {
    expect(INTERVENTIONS_CONVERSATION_TITLE).toBe(
      'Aurum interventions — recommendations & approvals',
    );
    expect(INTERVENTIONS_CONVERSATION_TITLE).not.toContain('\n');
  });

  it('the hub return link is the stable /chat?c= shape (the W072 seam)', () => {
    const linkage: InterventionsChatLinkage = {
      conversationId: 'conversation-1',
      recommendationProposalIds: [PROPOSAL_ID],
      decidedProposalIds: [],
      activatedProposalIds: [],
    };
    expect(interventionsChatHref(linkage)).toBe(chatConversationHref('conversation-1'));
    expect(interventionsChatHref(linkage)).toBe('/chat?c=conversation-1');
  });
});

// ---------------------------------------------------------------------------
// The payload round-trip (stored transcript turns re-parse)
// ---------------------------------------------------------------------------

describe('the stored payload round-trip', () => {
  it('a recommendation turn parses back through the chat payload guards', () => {
    const answer = recommendationAnswer(proposal());
    const parsed = parseTurnPayload({ text: renderRecommendationText(proposal()), answer });
    expect(parsed.answer?.cards.map((card) => card.kind)).toEqual([
      'capability',
      'intervention-proposal',
    ]);
    expect(parsed.answer?.cards[1]?.decision?.status).toBe('pending');
  });

  it('an activation turn parses back with the agent card', () => {
    const answer = activationAnswer(agent(), proposal({ status: 'approved' }));
    const parsed = parseTurnPayload({ text: 'Activated', answer });
    expect(parsed.answer?.cards.map((card) => card.kind)).toContain('intervention-agent');
  });
});

// ---------------------------------------------------------------------------
// The API body parsing (pure)
// ---------------------------------------------------------------------------

describe('parseChatProposalDecisionBody', () => {
  it('accepts approve/reject with a conversation id and a bounded note', () => {
    const parsed = parseChatProposalDecisionBody({
      decision: 'approve',
      conversationId: ' conversation-1 ',
      note: '  covers the peak  ',
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.decision).toBe('approve');
      expect(parsed.value.conversationId).toBe('conversation-1');
      expect(parsed.value.note).toBe('covers the peak');
    }
  });

  it('rejects a non-object body', () => {
    expect(parseChatProposalDecisionBody('approve').ok).toBe(false);
    expect(parseChatProposalDecisionBody(null).ok).toBe(false);
    expect(parseChatProposalDecisionBody([]).ok).toBe(false);
  });

  it('rejects an unknown decision value', () => {
    const parsed = parseChatProposalDecisionBody({ decision: 'maybe' });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toBe('invalid_body');
  });

  it('degrades a missing/blank conversation id and note to null', () => {
    const parsed = parseChatProposalDecisionBody({ decision: 'reject' });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.conversationId).toBeNull();
      expect(parsed.value.note).toBeNull();
    }
  });

  it('bounds the note length', () => {
    const parsed = parseChatProposalDecisionBody({
      decision: 'reject',
      note: 'x'.repeat(600),
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.note?.length).toBe(500);
  });
});

describe('parseChatProposalActivationBody', () => {
  it('accepts a minimal body (every field optional — the proposal derives)', () => {
    const parsed = parseChatProposalActivationBody({});
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.conversationId).toBeNull();
      expect(parsed.value.slug).toBeNull();
      expect(parsed.value.permissions).toBeNull();
    }
  });

  it('accepts full overrides including the permission scope list', () => {
    const parsed = parseChatProposalActivationBody({
      conversationId: 'conversation-1',
      slug: 'custom-slug',
      displayName: 'Custom name',
      role: 'Custom role',
      instructions: 'Custom instructions',
      provider: 'langgraph',
      permissions: ['observe', 'analyze'],
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.slug).toBe('custom-slug');
      expect(parsed.value.permissions).toEqual(['observe', 'analyze']);
    }
  });

  it('rejects a non-object body', () => {
    expect(parseChatProposalActivationBody('nope').ok).toBe(false);
    expect(parseChatProposalActivationBody(null).ok).toBe(false);
  });

  it('degrades a non-string permission list to null (the proposal scopes win)', () => {
    const parsed = parseChatProposalActivationBody({ permissions: 'observe' });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.permissions).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The error mapping (code-carrying domain errors → honest API outcomes)
// ---------------------------------------------------------------------------

describe('interventionsChatApiError', () => {
  it('maps the interventions state error to 409', () => {
    const error = interventionsChatApiError(
      new InterventionStateError('this proposal is rejected — activation follows an approved proposal'),
    );
    expect(error.status).toBe(409);
    expect(error.body.error).toBe('intervention_state');
  });

  it('maps the actions module\'s separation-of-duties refusal to 403', () => {
    const error = interventionsChatApiError(
      new ActionsError('forbidden', 'the requesting principal cannot decide its own request'),
    );
    expect(error.status).toBe(403);
  });

  it('maps the actions module\'s not_pending to 409 (first decision wins)', () => {
    const error = interventionsChatApiError(new ActionsError('not_pending', 'already decided'));
    expect(error.status).toBe(409);
  });

  it('maps recruitment not-found codes to 404', () => {
    const error = interventionsChatApiError(
      new AgentRecruitmentError('proposal_not_found', 'no proposal at this id'),
    );
    expect(error.status).toBe(404);
  });

  it('maps an unknown error with no code to 500 internal', () => {
    const error = interventionsChatApiError(new Error('boom'));
    expect(error.status).toBe(500);
    expect(error.body.error).toBe('internal');
  });
});
