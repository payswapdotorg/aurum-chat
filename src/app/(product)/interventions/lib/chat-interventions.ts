// Conversational interventions & approval continuity (W074) — the
// Interventions module's domain-service glue that drives the capability,
// workforce and automation recommendation chain from the CONVERSATION.
//
// THE WORK ITEM (frozen plan §5 W074): "Make agent/workforce/automation
// recommendations conversationally actionable." The manager understands a
// recommendation in Chat, approves it there (the human authority gate,
// inline on the card), activates it there, and the post-action outcome
// RETURNS TO THE ORIGINATING THREAD — while the detailed Interventions
// surfaces stay available (and authoritative) for deeper management work.
//
// WHAT THIS MODULE ADDS (the W073 learning-chat precedent, intervention
// lane — the SAME domain workflows the Interventions surface drives,
// never a second source of truth):
//
//   * ONE persistent "Aurum interventions" conversation per tenant —
//     found through the conversations contract (exact-title match),
//     created on first delivery;
//   * THE RECOMMENDATION — Aurum's awaiting recruitment proposals arrive
//     as proactive chat messages (left-aligned Aurum turns,
//     WhatsApp-like): each message carries the CAPABILITY-GAP card (the
//     shared model's capability kind — the gap the proposal addresses)
//     plus the INTERVENTION-PROPOSAL card (the shared model's W074
//     station kind: the comparison rendered conversationally legible,
//     the proposal state, and — while the gate holds it — the pending
//     decision payload that renders the inline human approval);
//   * THE INLINE HUMAN DECISION — decideProposalInChat casts the human
//     vote through the actions module's decideApproval (claim-gated,
//     separation of duties — the SAME gate the Interventions surface
//     drives), settles it onto the proposal (settleRecruitmentProposal,
//     idempotent, first decision wins), and records the OUTCOME message
//     in the ORIGINATING thread: proposal state + decision trail +
//     evidence citations, plus the activation affordance when the
//     approved comparison carries a recruit alternative;
//   * THE ACTIVATION — activateProposalInChat registers the agent through
//     the agents module's claim-gated contract with EXACTLY the scopes
//     the approved comparison proposed (activateRecruitedAgent), then
//     records the activation outcome in the same thread with the AGENT
//     card (the shared model's W074 station kind: status, scopes and the
//     retain/modify/terminate LIFECYCLE CONTEXT, human-authorized);
//   * THE CONVERGENCE SWEEP — deliverInterventionRecommendationsToChat
//     delivers awaiting recommendations (idempotent per proposal) and
//     converges the thread with outcome messages for recommendations
//     that were since decided (here or on any other surface — the
//     transcript mirrors the domain, never the reverse);
//   * THE HUB LINKAGE — interventionsChatLinkage reads the thread's id
//     (the stable `/chat?c=` return link) and which proposals it carries,
//     so the Interventions hub can point at the SAME governance truth
//     from both surfaces.
//
// HUMAN AUTHORIZATION (lock 20/21/23; ARCHITECTURE-LOCK "human
// employment decisions remain human-authorized"): nothing here decides,
// approves or terminates anything by itself. Every consequential
// transition goes through the actions module's human gate, and the
// safeguard copy rides every consequential card (the renderer's note —
// see chat/components/interventions/). The chat is a CHANNEL; the
// Interventions and Approvals surfaces (and the domain beneath them)
// remain the truth (lock 35).

import { now } from '@/infra/clock';
import type { TenantContext } from '@/infra/tenant';
import {
  createConversation,
  getConversation,
  listConversations,
  listMessages,
  recordMessage,
} from '@/modules/conversations/contract';
import type { Conversation, Message } from '@/modules/conversations/contract';
import { getActionRequest } from '@/modules/actions/contract';
import type { ActionRequest } from '@/modules/actions/contract';
import { ActionsError, decideApproval } from '@/modules/actions/contract';
import {
  getRecruitmentProposal,
  listRecruitmentProposals,
  settleRecruitmentProposal,
} from '@/modules/agent-recruitment/contract';
import type {
  AgentRecruitmentProposal,
  RecruitmentAlternative,
  RecruitmentProposalStatus,
} from '@/modules/agent-recruitment/contract';
import { registerAgent } from '@/modules/agents/contract';
import type { AgentDefinition } from '@/modules/agents/contract';
import type {
  ChatAnswer,
  ChatCard,
  ChatCardContext,
  ChatCitation,
  ChatTurnPayload,
} from '../../chat/lib/chat-types';
import { chatConversationHref } from '../../chat/lib/chat-types';
import { InterventionStateError } from './workflow';
import type { ValidatedActivationInput } from './form';
import { validateActivationInput } from './form';
import {
  agentStatusLabel,
  agentStatusTone,
  alternativeKindLabel,
  gapStatusLabel,
  gapStatusTone,
  moneyLabel,
  percentLabel,
  weeksLabel,
} from './labels';

// ---------------------------------------------------------------------------
// The persistent interventions conversation
// ---------------------------------------------------------------------------

/** The persistent interventions thread's title (the find-or-create key). */
export const INTERVENTIONS_CONVERSATION_TITLE =
  'Aurum interventions — recommendations & approvals';

/** The provider-message-id prefixes (per-proposal idempotency keys). */
export const INTERVENTION_REC_PREFIX = 'intervention-rec-';
export const INTERVENTION_OUTCOME_PREFIX = 'intervention-outcome-';
export const INTERVENTION_ACTIVATION_PREFIX = 'intervention-activation-';

/** How many awaiting recommendations one sweep delivers (oldest first). */
export const RECOMMENDATION_DELIVERY_LIMIT = 5;

/** How many decided proposals one sweep converges (newest first). */
export const OUTCOME_ENSURE_LIMIT = 5;

/** The recent-message window the sweep scans for delivered ids. */
export const SWEEP_WINDOW = 200;

/** The provider message id of one proposal's recommendation message. */
export function recommendationProviderMessageId(proposalId: string): string {
  return `${INTERVENTION_REC_PREFIX}${proposalId}`;
}

/** The provider message id of one proposal's decision-outcome message. */
export function outcomeProviderMessageId(proposalId: string): string {
  return `${INTERVENTION_OUTCOME_PREFIX}${proposalId}`;
}

/** The provider message id of one proposal's activation-outcome message. */
export function activationProviderMessageId(proposalId: string): string {
  return `${INTERVENTION_ACTIVATION_PREFIX}${proposalId}`;
}

/**
 * Find the tenant's persistent interventions conversation (exact-title
 * match over the bounded titleContains read), or null when none exists.
 */
export async function findInterventionsConversation(
  ctx: TenantContext,
): Promise<Conversation | null> {
  const candidates = await listConversations(ctx, {
    titleContains: INTERVENTIONS_CONVERSATION_TITLE,
    limit: 50,
  });
  return (
    candidates.find(
      (conversation) => conversation.title === INTERVENTIONS_CONVERSATION_TITLE,
    ) ?? null
  );
}

/** Find or create the persistent interventions conversation. */
export async function ensureInterventionsConversation(
  ctx: TenantContext,
): Promise<Conversation> {
  const existing = await findInterventionsConversation(ctx);
  if (existing !== null) return existing;
  return createConversation(ctx, { title: INTERVENTIONS_CONVERSATION_TITLE });
}

// ---------------------------------------------------------------------------
// Pure presentation helpers (the unit-test seam)
// ---------------------------------------------------------------------------

function clip(text: string, bound: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= bound ? flat : `${flat.slice(0, bound - 1)}…`;
}

/**
 * One compared alternative as ONE conversationally legible line — the
 * kind word first (a manager reads "Recruit — …", not an internal code),
 * then the summary, then the same dimensions the detail comparison
 * table carries: cost · weeks · level contribution. The recommended
 * alternative says so (the proposer's flag, never the decision).
 */
export function comparisonLine(alternative: RecruitmentAlternative): string {
  const dims: string[] = [];
  if (alternative.estimatedCostMinor !== null) {
    dims.push(
      moneyLabel(
        alternative.estimatedCostMinor,
        alternative.estimatedCostCurrency ?? 'USD',
      ),
    );
  }
  if (alternative.estimatedWeeks !== null) dims.push(weeksLabel(alternative.estimatedWeeks));
  if (alternative.expectedLevel !== null) {
    dims.push(`+${percentLabel(alternative.expectedLevel)} level`);
  }
  if (alternative.expectedCapacity !== null) {
    dims.push(`+${alternative.expectedCapacity} capacity`);
  }
  const dimText = dims.length === 0 ? 'no estimates recorded' : dims.join(' · ');
  return `${alternativeKindLabel(alternative.kind)} — ${clip(alternative.summary, 160)} (${dimText})${
    alternative.recommended ? ' · recommended' : ''
  }`;
}

/** The proposal's whole comparison, one line per alternative. */
export function comparisonLines(
  alternatives: readonly RecruitmentAlternative[],
): string[] {
  return alternatives.map(comparisonLine);
}

/** The proposal's status chip copy (chat-side, calm). */
export function proposalStatusLabelChat(status: RecruitmentProposalStatus): string {
  switch (status) {
    case 'awaiting_approval':
      return 'Needs your decision';
    case 'approved':
      return 'Approved';
    case 'rejected':
      return 'Rejected';
    case 'proposed':
      return 'Draft — not at the gate';
    case 'withdrawn':
      return 'Withdrawn';
  }
}

/** The proposal card's tone (the hub's own mapping). */
function proposalToneChat(status: RecruitmentProposalStatus): ChatCard['tone'] {
  if (status === 'awaiting_approval') return 'warning';
  if (status === 'approved') return 'positive';
  return 'neutral';
}

/** The proposed scopes line (recruit alternatives only). */
function scopesLine(alternative: RecruitmentAlternative | null): string | null {
  if (alternative === null || alternative.agentPermissions === null) return null;
  if (alternative.agentPermissions.length === 0) return null;
  return `Proposed agent scopes: ${alternative.agentPermissions.join(' / ')}${
    alternative.impliedAuthorityLevel === null
      ? ''
      : ` — implies ${alternative.impliedAuthorityLevel} authority (the gate reviews every execution)`
  }`;
}

/** The evidence citations a proposal message carries (W072 contract). */
export function proposalCitations(proposal: AgentRecruitmentProposal): ChatCitation[] {
  const citations: ChatCitation[] = proposal.evidenceObservationIds.map((id) => ({
    kind: 'observation',
    id,
    label: `Evidence observation ${id.slice(0, 8)}`,
    detail: 'Immutable observation the comparison was computed against',
    href: '/evidence',
  }));
  if (proposal.approval.actionRequestId !== null) {
    citations.push({
      kind: 'action-request',
      id: proposal.approval.actionRequestId,
      label: `Authority-gate request ${proposal.approval.actionRequestId.slice(0, 8)}`,
      detail: 'The human decision this proposal waits for (or was decided by)',
      href: '/approvals',
    });
  }
  return citations;
}

/** The capability-gap context drawer (the "why this matters" payload). */
function gapContext(proposal: AgentRecruitmentProposal): ChatCardContext {
  const capability = proposal.capability;
  return {
    subtitle: 'The capability gap this recommendation addresses',
    sections: [
      {
        kind: 'why',
        title: 'Why this matters',
        lines: [clip(proposal.rationale, 400)],
        links: [],
      },
      {
        kind: 'detail',
        title: 'What the comparison was computed against',
        lines: [
          `Capability: ${capability.capabilityName}`,
          capability.gapStatus === null
            ? 'No gap classification at proposal time'
            : `Gap: ${gapStatusLabel(capability.gapStatus)}`,
          `Best active level: ${
            capability.bestActiveLevel === null
              ? 'none'
              : percentLabel(capability.bestActiveLevel)
          }`,
          `Total active capacity: ${capability.totalActiveCapacity ?? 'unknown'}`,
        ],
        links: [{ label: 'Open the capability surface', href: '/capabilities' }],
      },
      {
        kind: 'evidence',
        title: 'Evidence and reasoning',
        lines: [
          proposal.evidenceObservationIds.length === 0
            ? 'No observations cited — the comparison rests on the capability snapshot alone.'
            : `${proposal.evidenceObservationIds.length} cited observation${
                proposal.evidenceObservationIds.length === 1 ? '' : 's'
              } — the immutable records behind the gap.`,
        ],
        links: [{ label: 'Open the Evidence surface', href: '/evidence' }],
      },
    ],
  };
}

/**
 * The capability-gap card (the recommendation's demand side): an
 * instance of the shared model's `capability` kind — the gap the
 * proposal addresses, deep-linking into the COMPARISON (the proposal
 * detail page) rather than the bare capability list, because the
 * legible alternatives live there.
 */
export function capabilityGapCard(proposal: AgentRecruitmentProposal): ChatCard {
  const capability = proposal.capability;
  return {
    kind: 'capability',
    id: capability.capabilityId,
    title: capability.capabilityName,
    statusLabel:
      capability.gapStatus === null ? 'No gap classification' : gapStatusLabel(capability.gapStatus),
    tone: capability.gapStatus === null ? 'neutral' : gapStatusTone(capability.gapStatus),
    meta: [
      `Best active level: ${
        capability.bestActiveLevel === null ? 'none' : percentLabel(capability.bestActiveLevel)
      }`,
      `Total active capacity: ${capability.totalActiveCapacity ?? 'unknown'}`,
      `${proposal.alternatives.length} compared alternative${
        proposal.alternatives.length === 1 ? '' : 's'
      } on the proposal`,
    ],
    href: `/interventions/proposals/${proposal.id}`,
    linkLabel: 'Open the comparison',
    decision: null,
    context: gapContext(proposal),
  };
}

/** The proposal card's context drawer (the decision-time payload). */
function proposalContext(proposal: AgentRecruitmentProposal): ChatCardContext {
  const recruit = proposal.alternatives.find(
    (alternative) => alternative.kind === 'recruit',
  );
  const sections: ChatCardContext['sections'] = [
    {
      kind: 'summary',
      title: 'The proposal',
      lines: [clip(proposal.rationale, 400)],
      links: [],
    },
    {
      kind: 'policy',
      title: 'The human authority gate',
      lines: [
        'Aurum proposes the comparison; an authorized human decides the acquisition.',
        proposal.approval.policyOutcome === null
          ? 'No policy evaluation recorded.'
          : `Gate outcome: ${proposal.approval.policyOutcome.replace('_', ' ')}${
              proposal.approval.policyResolvedVia === null
                ? ''
                : ` (via ${proposal.approval.policyResolvedVia})`
            }`,
        'Separation of duties holds: whoever submitted the proposal can never decide it.',
      ],
      links: [{ label: 'Open Approvals (management mode)', href: '/approvals' }],
    },
    {
      kind: 'evidence',
      title: 'Evidence and reasoning',
      lines: [
        proposal.evidenceObservationIds.length === 0
          ? 'No observations cited.'
          : `${proposal.evidenceObservationIds.length} cited observation${
              proposal.evidenceObservationIds.length === 1 ? '' : 's'
            }.`,
      ],
      links: [{ label: 'Open the Evidence surface', href: '/evidence' }],
    },
  ];
  const scopes = scopesLine(recruit ?? null);
  if (scopes !== null) {
    sections.push({
      kind: 'detail',
      title: 'The future grant, visible now',
      lines: [scopes],
      links: [],
    });
  }
  return {
    subtitle: 'A capability-gap acquisition comparison — decided by a human',
    sections,
  };
}

/**
 * The intervention-proposal card (the shared model's W074 station kind):
 * the comparison as legible meta lines, the proposal state as the
 * status chip, and — while the gate holds the proposal — the pending
 * decision payload that renders the INLINE human approval on the card.
 */
export function interventionProposalCard(
  proposal: AgentRecruitmentProposal,
): ChatCard {
  const recommended = proposal.recommendation;
  const recruit = proposal.alternatives.find(
    (alternative) => alternative.kind === 'recruit',
  );
  const requestId = proposal.approval.actionRequestId;
  const decision =
    requestId !== null &&
    (proposal.status === 'awaiting_approval' ||
      proposal.status === 'approved' ||
      proposal.status === 'rejected')
      ? {
          requestId,
          status:
            proposal.status === 'awaiting_approval'
              ? ('pending' as const)
              : proposal.status === 'approved'
                ? ('approved' as const)
                : ('rejected' as const),
        }
      : null;
  const statusLabel =
    proposal.status === 'approved' && recruit !== null
      ? 'Approved — activation available'
      : proposalStatusLabelChat(proposal.status);
  const meta = [
    recommended === null
      ? 'No recommended alternative — human judgment required'
      : `Recommended: ${comparisonLine(recommended)}`,
    ...comparisonLines(proposal.alternatives),
    `Capability: ${proposal.capability.capabilityName}${
      proposal.capability.gapStatus === null
        ? ''
        : ` — ${gapStatusLabel(proposal.capability.gapStatus)}`
    }`,
  ];
  if (recommended !== null && recommended.kind !== 'recruit') {
    const altScopes = scopesLine(recruit ?? null);
    if (altScopes !== null) meta.push(altScopes);
  }
  return {
    kind: 'intervention-proposal',
    id: proposal.id,
    title: clip(proposal.title, 300),
    statusLabel,
    tone: proposalToneChat(proposal.status),
    meta,
    href: `/interventions/proposals/${proposal.id}`,
    linkLabel: 'Open the proposal',
    decision,
    context: proposalContext(proposal),
  };
}

/** The agent card's lifecycle context (the retain/modify/terminate payload). */
function agentContext(agent: AgentDefinition, proposal: AgentRecruitmentProposal): ChatCardContext {
  return {
    subtitle: 'A recruited agent — an organizational actor with explicit scopes',
    sections: [
      {
        kind: 'why',
        title: 'Why this matters',
        lines: [
          clip(agent.role, 400),
          'Agents are organizational actors: their contracts, budgets, permissions and outcomes are explicit and inspectable.',
        ],
        links: [],
      },
      {
        kind: 'policy',
        title: 'The lifecycle — retain, modify, terminate',
        lines: [
          'Every lifecycle decision follows a measured evaluation — no decision without evidence.',
          'Aurum never autonomously terminates a human employee, and agent terminations route through the authority gate: an explicit human decision.',
          'Employment decisions stay human-authorized — this agent is a capability, not a person.',
        ],
        links: [
          { label: 'Open the agent detail (evaluations & lifecycle)', href: `/interventions/agents/${agent.id}` },
        ],
      },
      {
        kind: 'detail',
        title: 'Where it came from',
        lines: [
          `Activated from the approved proposal: ${clip(proposal.title, 200)}`,
          `Runtime provider: ${agent.provider} — swappable behind the agent gateway.`,
        ],
        links: [{ label: 'Open the Interventions hub', href: '/interventions' }],
      },
    ],
  };
}

/**
 * The recruited-agent card (the shared model's W074 station kind): the
 * activation OUTCOME — the agent now exists as an organizational actor,
 * with its scopes, its provenance, and the retain/modify/terminate
 * lifecycle context a manager needs to govern it.
 */
export function interventionAgentCard(
  agent: AgentDefinition,
  proposal: AgentRecruitmentProposal,
): ChatCard {
  return {
    kind: 'intervention-agent',
    id: agent.id,
    title: clip(agent.displayName ?? agent.slug, 300),
    statusLabel: agentStatusLabel(agent.status),
    tone: agentStatusTone(agent.status),
    meta: [
      `Role: ${clip(agent.role, 160)}`,
      `Scopes: ${agent.permissions.join(' / ')}`,
      `From the approved proposal: ${clip(proposal.title, 160)}`,
      'Lifecycle: retain / modify / terminate — decided by humans after measured evaluations',
    ],
    href: `/interventions/agents/${agent.id}`,
    linkLabel: 'Open the agent detail',
    decision: null,
    context: agentContext(agent, proposal),
  };
}

// ---------------------------------------------------------------------------
// Message texts and answer payloads (pure)
// ---------------------------------------------------------------------------

/** The recommendation message's text (the manager-facing ask). */
export function renderRecommendationText(proposal: AgentRecruitmentProposal): string {
  const recommended = proposal.recommendation;
  const recommendation = recommended === null
    ? 'no single alternative is recommended — human judgment required'
    : `the recommended alternative is ${alternativeKindLabel(recommended.kind).toLowerCase()}`;
  return (
    `A capability-gap recommendation needs your decision: "${clip(proposal.title, 120)}". ` +
    `${proposal.capability.capabilityName}${
      proposal.capability.gapStatus === null
        ? ''
        : ` is ${gapStatusLabel(proposal.capability.gapStatus).toLowerCase()}`
    } — the proposal compares ${proposal.alternatives.length} ways to close the gap, and ${recommendation}. ` +
    'You can decide right here, or open the comparison for the full detail — the Interventions surface keeps the authoritative record.'
  );
}

/** The decision-outcome message's text (approved / rejected). */
export function renderOutcomeText(
  proposal: AgentRecruitmentProposal,
  decidedHere: boolean,
  deciderName: string | null,
): string {
  const approved = proposal.status === 'approved';
  const who = deciderName === null ? 'an authorized human' : deciderName;
  const trail = decidedHere
    ? `${who} decided it in this thread — the decision trail is on the approval.`
    : `It was decided by ${who} — the recorded decision is attached; the trail lives on the approval.`;
  if (approved) {
    const recruit = proposal.alternatives.find(
      (alternative) => alternative.kind === 'recruit',
    );
    const next =
      recruit === undefined
        ? 'The approved comparison carries no agent recruitment — its alternative activates on the Interventions surface.'
        : 'The approved comparison carries a recruit alternative — you can activate it here, registering the agent with exactly the proposed scopes.';
    return `Approved — "${clip(proposal.title, 120)}". ${trail} ${next}`;
  }
  return (
    `Rejected — "${clip(proposal.title, 120)}". ${trail} ` +
    'A changed comparison is a new proposal; the detail surface carries the full history.'
  );
}

/** The activation-outcome message's text. */
export function renderActivationText(
  agent: AgentDefinition,
  proposal: AgentRecruitmentProposal,
  activatedBy: string | null = null,
): string {
  const who = activatedBy === null ? '' : ` ${activatedBy} ran the activation — `;
  return (
    `Activated — "${clip(agent.displayName ?? agent.slug, 120)}" is registered as an organizational actor with exactly the scopes the approved comparison proposed (${agent.permissions.join(' / ')}). ` +
    `${who}The approved human decision stays on the approval trail.` +
    'Its lifecycle — retain, modify or terminate — is decided by humans following measured evaluations, on the agent detail surface. ' +
    'The proposal remains approved on the Interventions surface; the outcome trail starts here.'
  );
}

/** The recommendation message's answer payload (the shared card model). */
export function recommendationAnswer(proposal: AgentRecruitmentProposal): ChatAnswer {
  const recommended = proposal.recommendation;
  return {
    intent: 'improve',
    mode: 'deterministic',
    headline: 'A capability-gap recommendation awaits a human decision',
    bullets: [
      `${proposal.capability.capabilityName} — ${
        proposal.capability.gapStatus === null
          ? 'no gap classification'
          : gapStatusLabel(proposal.capability.gapStatus)
      }`,
      `${proposal.alternatives.length} compared alternatives (cost · weeks · level contribution each)`,
      recommended === null
        ? 'No recommended alternative — human judgment required'
        : `Recommended: ${alternativeKindLabel(recommended.kind)} — ${clip(recommended.summary, 200)}`,
    ],
    note: null,
    cards: [capabilityGapCard(proposal), interventionProposalCard(proposal)],
    citations: proposalCitations(proposal),
    executionId: null,
  };
}

/** The decision-outcome message's answer payload. */
export function outcomeAnswer(
  proposal: AgentRecruitmentProposal,
  decidedHere: boolean,
): ChatAnswer {
  return {
    intent: 'improve',
    mode: 'deterministic',
    headline:
      proposal.status === 'approved'
        ? 'Approved — the human decision is recorded'
        : 'Rejected — the human decision is recorded',
    bullets: [
      decidedHere
        ? 'Decided in this thread — the vote and its note are on the approval trail.'
        : 'Already decided (first decision wins) — the recorded state is attached.',
      proposal.status === 'approved'
        ? 'The approved comparison can be activated — registering the agent with exactly the proposed scopes.'
        : 'A changed comparison is a new proposal — the Interventions surface carries the history.',
    ],
    note: null,
    cards: [interventionProposalCard(proposal), capabilityGapCard(proposal)],
    citations: proposalCitations(proposal),
    executionId: null,
  };
}

/** The activation-outcome message's answer payload. */
export function activationAnswer(
  agent: AgentDefinition,
  proposal: AgentRecruitmentProposal,
): ChatAnswer {
  return {
    intent: 'improve',
    mode: 'deterministic',
    headline: 'Activation complete — the agent is an organizational actor',
    bullets: [
      `Scopes granted: ${agent.permissions.join(' / ')} — exactly what the approved comparison proposed`,
      'Lifecycle decisions (retain / modify / terminate) follow measured evaluations and human authority',
    ],
    note: null,
    cards: [interventionAgentCard(agent, proposal), interventionProposalCard(proposal)],
    citations: proposalCitations(proposal),
    executionId: null,
  };
}

// ---------------------------------------------------------------------------
// The delivery sweep (the proactive recommendation + convergence)
// ---------------------------------------------------------------------------

/** What one delivery sweep produced. */
export interface InterventionChatDelivery {
  ok: true;
  /** True when NEW messages were recorded this call. */
  delivered: boolean;
  /** The persistent interventions conversation (null when none was needed). */
  conversationId: string | null;
  /** Awaiting proposals found (the full feed, pre-limit). */
  awaitingCount: number;
  /** Recommendation messages recorded this sweep. */
  recommendationsRecorded: number;
  /** Outcome messages recorded this sweep (decided proposals converged). */
  outcomesRecorded: number;
  /** Awaiting recommendations already in the thread (skipped). */
  recommendationsDeduped: number;
  /** Which proposal ids now have a recommendation in the thread. */
  recommendationProposalIds: string[];
}

/** Why a sweep did not happen (honest, never silent). */
export type InterventionChatDeliveryRefusal = { ok: false; reason: 'reads_unavailable' };

/**
 * Deliver the tenant's awaiting recruitment proposals into the
 * persistent interventions conversation as recommendation messages, and
 * converge the thread with outcome messages for recommendations that
 * have since been decided — wherever the decision happened (here, the
 * Interventions surface, or the generic chat approval card). One
 * recommendation message per proposal (idempotent forever), one outcome
 * message per decided proposal. The transcript mirrors the domain,
 * never the reverse.
 */
export async function deliverInterventionRecommendationsToChat(
  ctx: TenantContext,
): Promise<InterventionChatDelivery | InterventionChatDeliveryRefusal> {
  let proposals: AgentRecruitmentProposal[];
  try {
    proposals = await listRecruitmentProposals(ctx, { limit: 100 });
  } catch {
    return { ok: false, reason: 'reads_unavailable' };
  }

  // The proposals the sweep cares about: at the gate (or decided) and
  // actually submitted — drafts and withdrawals are Interventions-surface
  // concerns, not thread concerns.
  const atTheGate = proposals.filter(
    (proposal) =>
      proposal.approval.actionRequestId !== null &&
      (proposal.status === 'awaiting_approval' ||
        proposal.status === 'approved' ||
        proposal.status === 'rejected'),
  );

  const existing = await findInterventionsConversation(ctx);
  if (atTheGate.length === 0 && existing === null) {
    return {
      ok: true,
      delivered: false,
      conversationId: null,
      awaitingCount: 0,
      recommendationsRecorded: 0,
      outcomesRecorded: 0,
      recommendationsDeduped: 0,
      recommendationProposalIds: [],
    };
  }

  const conversation = existing ?? (await ensureInterventionsConversation(ctx));

  // The idempotency window: which recommendation/outcome provider ids
  // the thread already carries (bounded; the contract's (tenant,
  // channel, providerMessageId) dedupe is the final guard either way).
  const recent = await listMessages(ctx, {
    conversationId: conversation.id,
    order: 'desc',
    limit: SWEEP_WINDOW,
  });
  const known = new Set(
    recent
      .map((message) => message.providerMessageId)
      .filter((id): id is string => id !== null),
  );

  let recommendationsRecorded = 0;
  let outcomesRecorded = 0;
  let recommendationsDeduped = 0;
  const recommendationProposalIds: string[] = [];
  let deliveredBudget = RECOMMENDATION_DELIVERY_LIMIT;

  // Awaiting proposals deliver OLDEST first (the learning sweep's
  // discipline — the oldest decision debt surfaces first).
  const awaiting = atTheGate
    .filter((proposal) => proposal.status === 'awaiting_approval')
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));

  for (const proposal of awaiting) {
    const recId = recommendationProviderMessageId(proposal.id);
    if (known.has(recId)) {
      recommendationsDeduped += 1;
      recommendationProposalIds.push(proposal.id);
      continue;
    }
    // The gate request's LIVE status decides what the thread shows: a
    // proposal recorded as awaiting whose request was already decided
    // elsewhere converges (settle + outcome) instead of asking again.
    // A failed read stays quiet — the recorded state is authoritative.
    let request: ActionRequest | null;
    try {
      request = await getActionRequest(ctx, { requestId: proposal.approval.actionRequestId! });
    } catch {
      request = null;
    }
    if (request === null || request.status === 'pending') {
      if (deliveredBudget === 0) continue;
      deliveredBudget -= 1;
      await recordMessage(ctx, {
        conversationId: conversation.id,
        direction: 'outbound',
        actor: { kind: 'system', label: 'Aurum' },
        channel: 'web',
        payload: {
          text: renderRecommendationText(proposal),
          starterId: null,
          answer: recommendationAnswer(proposal),
        } satisfies ChatTurnPayload,
        sentAt: now().toISOString(),
        providerMessageId: recId,
      });
      known.add(recId);
      recommendationProposalIds.push(proposal.id);
      recommendationsRecorded += 1;
      continue;
    }
    // The gate was decided elsewhere (the generic chat approval card or
    // the Approvals surface) but the proposal has not settled — the
    // sweep settles it (idempotent) and converges the thread.
    const settled = await settleRecruitmentProposal(ctx, { proposalId: proposal.id });
    await recordOutcomeMessage(ctx, conversation.id, settled, false, null);
    known.add(outcomeProviderMessageId(proposal.id));
    recommendationProposalIds.push(proposal.id);
    outcomesRecorded += 1;
  }

  // Convergence: settled proposals whose recommendation was delivered
  // once get their outcome message ensured (decided here OR elsewhere).
  const decided = atTheGate
    .filter((proposal) => proposal.status === 'approved' || proposal.status === 'rejected')
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, OUTCOME_ENSURE_LIMIT);
  for (const proposal of decided) {
    const outcomeId = outcomeProviderMessageId(proposal.id);
    if (known.has(outcomeId)) continue;
    const recDelivered =
      known.has(recommendationProviderMessageId(proposal.id)) ||
      recommendationProposalIds.includes(proposal.id);
    if (!recDelivered) continue; // the thread never carried this recommendation
    const fresh = await getRecruitmentProposal(ctx, { proposalId: proposal.id });
    await recordOutcomeMessage(ctx, conversation.id, fresh, false, null);
    known.add(outcomeId);
    outcomesRecorded += 1;
  }

  return {
    ok: true,
    delivered: recommendationsRecorded > 0 || outcomesRecorded > 0,
    conversationId: conversation.id,
    awaitingCount: awaiting.length,
    recommendationsRecorded,
    outcomesRecorded,
    recommendationsDeduped,
    recommendationProposalIds,
  };
}

// ---------------------------------------------------------------------------
// The inline decision workflow (the human authority gate, from the thread)
// ---------------------------------------------------------------------------

/** One inline decision: which thread (null = the interventions conversation). */
export interface ChatProposalDecisionInput {
  conversationId: string | null;
  decision: 'approve' | 'reject';
  note: string | null;
}

/** What one inline decision produced. */
export interface ChatProposalDecisionOutcome {
  status: 'approved' | 'rejected';
  proposalId: string;
  /** False when another approver's decision already won (first-write-wins). */
  decidedHere: boolean;
  /** The thread the outcome message returned to. */
  conversationId: string;
  /** Aurum's outcome reply (left-aligned, cards + citations). */
  outcome: Message;
  /** The linked authority-gate request. */
  actionRequestId: string;
  decidedBy: string | null;
  decidedAt: string | null;
}

/** Record one proposal's decision-outcome message (idempotent per proposal). */
async function recordOutcomeMessage(
  ctx: TenantContext,
  conversationId: string,
  proposal: AgentRecruitmentProposal,
  decidedHere: boolean,
  deciderName: string | null,
): Promise<Message> {
  const text = renderOutcomeText(proposal, decidedHere, deciderName);
  return recordMessage(ctx, {
    conversationId,
    direction: 'outbound',
    actor: { kind: 'system', label: 'Aurum' },
    channel: 'web',
    payload: {
      text,
      starterId: null,
      answer: outcomeAnswer(proposal, decidedHere),
    } satisfies ChatTurnPayload,
    sentAt: now().toISOString(),
    providerMessageId: outcomeProviderMessageId(proposal.id),
  });
}

/**
 * Decide one awaiting recruitment proposal FROM THE THREAD — the SAME
 * domain workflow the Interventions surface drives:
 *
 *   1. the HUMAN decision on the linked action request (decideApproval —
 *      claim-gated, separation of duties enforced in the actions
 *      module: the submitting principal can never decide its own
 *      proposal);
 *   2. the settle onto the proposal (settleRecruitmentProposal —
 *      idempotent; a re-click after another approver's decision lands
 *      the recorded state, first-write-wins);
 *   3. the OUTCOME message into the ORIGINATING thread (the passed
 *      conversation, else the persistent interventions conversation),
 *      carrying the settled proposal card (with the activation
 *      affordance when the approved comparison carries a recruit
 *      alternative), the decision trail and the evidence citations.
 *
 * Nothing here can decide, un-decide or rewrite anything: approvals
 * are terminal and append-only in the domain, and the transcript only
 * mirrors what happened.
 */
export async function decideProposalInChat(
  ctx: TenantContext,
  proposalId: string,
  input: ChatProposalDecisionInput,
  deciderDisplayName: string,
): Promise<ChatProposalDecisionOutcome> {
  const proposal = await getRecruitmentProposal(ctx, { proposalId });
  if (proposal.status !== 'awaiting_approval') {
    throw new InterventionStateError(
      `this proposal is ${proposal.status} — only a proposal waiting at the approval gate can be decided here`,
    );
  }
  const requestId = proposal.approval.actionRequestId;
  if (requestId === null) {
    throw new InterventionStateError(
      'this proposal carries no authority-gate request — it cannot be decided here',
    );
  }

  let decidedHere = true;
  try {
    await decideApproval(ctx, {
      requestId,
      decision: input.decision,
      note:
        input.note === null
          ? 'Decided in the Aurum chat'
          : `${input.note} (decided in the Aurum chat)`,
    });
  } catch (error) {
    if (error instanceof ActionsError && error.code === 'not_pending') {
      // Another authorized human (or a policy row) already decided this
      // request; the settle below lands the recorded decision — the
      // domain's own first-write-wins discipline, surfaced honestly.
      decidedHere = false;
    } else {
      throw error;
    }
  }

  const settled = await settleRecruitmentProposal(ctx, { proposalId });
  const conversation =
    input.conversationId === null
      ? await ensureInterventionsConversation(ctx)
      : await getConversation(ctx, input.conversationId);

  const outcome = await recordOutcomeMessage(
    ctx,
    conversation.id,
    settled,
    decidedHere,
    deciderDisplayName,
  );

  return {
    status: settled.status === 'approved' ? 'approved' : 'rejected',
    proposalId,
    decidedHere,
    conversationId: conversation.id,
    outcome,
    actionRequestId: requestId,
    decidedBy: settled.approval.decidedBy,
    decidedAt: settled.approval.decidedAt,
  };
}

// ---------------------------------------------------------------------------
// The activation workflow (the approved recruit, from the thread)
// ---------------------------------------------------------------------------

/** One inline activation: which thread (null = the interventions conversation). */
export interface ChatProposalActivationInput {
  conversationId: string | null;
  /** Optional overrides; the proposal derives the suggested activation. */
  slug?: string | null;
  displayName?: string | null;
  role?: string | null;
  instructions?: string | null;
  provider?: string | null;
  permissions?: string[] | null;
}

/** What one inline activation produced. */
export interface ChatProposalActivationOutcome {
  proposalId: string;
  agent: AgentDefinition;
  /** False when an agent with this slug already stood (idempotent replay). */
  created: boolean;
  /** The thread the outcome message returned to. */
  conversationId: string;
  /** Aurum's activation reply (the agent card + the lifecycle context). */
  outcome: Message;
}

/**
 * Derive the suggested activation input from an APPROVED proposal — the
 * same defaults the Interventions activation form pre-fills
 * (buildProposalView's activation block), so a one-click activation
 * from chat registers EXACTLY what the approved comparison proposed.
 */
function suggestedActivationOf(
  proposal: AgentRecruitmentProposal,
  overrides: ChatProposalActivationInput,
): ValidatedActivationInput {
  const recruit = proposal.alternatives.find(
    (alternative) => alternative.kind === 'recruit',
  );
  const base = {
    slug:
      overrides.slug === null || overrides.slug === undefined || overrides.slug === ''
        ? suggestedSlugOf(proposal.title)
        : overrides.slug,
    displayName:
      overrides.displayName === null || overrides.displayName === undefined
        ? (recruit?.summary ?? proposal.title)
        : overrides.displayName,
    role:
      overrides.role === null || overrides.role === undefined || overrides.role === ''
        ? clip(recruit === undefined ? proposal.title : recruit.summary, 120)
        : overrides.role,
    description: null,
    provider:
      overrides.provider === null || overrides.provider === undefined || overrides.provider === ''
        ? 'langgraph'
        : overrides.provider,
    instructions:
      overrides.instructions === null ||
      overrides.instructions === undefined ||
      overrides.instructions === ''
        ? `Act on the approved recruitment proposal '${proposal.title}': ${clip(
            proposal.rationale,
            1200,
          )}`
        : overrides.instructions,
    permissions: recruit?.agentPermissions ?? ['observe'],
  };
  return validateActivationInput(base);
}

/** Derive the activation affordance's suggested slug from a title. */
export function suggestedSlugOf(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug === '' ? 'recruited-agent' : slug;
}

/**
 * Activate an APPROVED proposal's recruit alternative FROM THE THREAD —
 * the SAME domain workflow the Interventions surface drives
 * (activateRecruitedAgent: registerAgent through the agents module's
 * claim-gated contract, with EXACTLY the scopes the approved comparison
 * proposed), then the activation outcome lands in the SAME conversation:
 * the agent card (scopes + retain/modify/terminate lifecycle context)
 * plus the settled proposal card. Registering is idempotent per (tenant,
 * slug) — a retry replays the same agent.
 */
export async function activateProposalInChat(
  ctx: TenantContext,
  proposalId: string,
  input: ChatProposalActivationInput,
  activatorDisplayName: string,
): Promise<ChatProposalActivationOutcome> {
  const proposal = await getRecruitmentProposal(ctx, { proposalId });
  if (proposal.status !== 'approved') {
    throw new InterventionStateError(
      `this proposal is ${proposal.status} — activation follows an approved proposal`,
    );
  }
  const recruit = proposal.alternatives.find(
    (alternative) => alternative.kind === 'recruit',
  );
  if (recruit === undefined) {
    throw new InterventionStateError(
      'this proposal compares no agent recruitment — its approved alternative activates elsewhere (training, hiring, automation or an install)',
    );
  }

  const validated = suggestedActivationOf(proposal, input);
  const registered = await registerAgent(ctx, {
    slug: validated.slug,
    displayName: validated.displayName,
    role: validated.role,
    description: validated.description,
    provider: validated.provider,
    instructions: validated.instructions,
    permissions: validated.permissions,
  });

  const conversation =
    input.conversationId === null
      ? await ensureInterventionsConversation(ctx)
      : await getConversation(ctx, input.conversationId);

  // The activation outcome composes from LIVE domain state (the fresh
  // proposal re-read keeps the card honest even on a replayed click).
  const fresh = await getRecruitmentProposal(ctx, { proposalId });
  const text = renderActivationText(registered.agent, fresh, activatorDisplayName);
  const outcome = await recordMessage(ctx, {
    conversationId: conversation.id,
    direction: 'outbound',
    actor: { kind: 'system', label: 'Aurum' },
    channel: 'web',
    payload: {
      text,
      starterId: null,
      answer: activationAnswer(registered.agent, fresh),
    } satisfies ChatTurnPayload,
    sentAt: now().toISOString(),
    providerMessageId: activationProviderMessageId(proposalId),
  });

  return {
    proposalId,
    agent: registered.agent,
    created: registered.created,
    conversationId: conversation.id,
    outcome,
  };
}

// ---------------------------------------------------------------------------
// The Interventions surface's chat linkage (the return-link seam)
// ---------------------------------------------------------------------------

/** Which intervention surface records also live in the interventions thread. */
export interface InterventionsChatLinkage {
  conversationId: string;
  /** Proposal ids whose recommendation was delivered into the thread. */
  recommendationProposalIds: string[];
  /** Proposal ids whose decision outcome is in the thread. */
  decidedProposalIds: string[];
  /** Proposal ids whose activation outcome is in the thread. */
  activatedProposalIds: string[];
}

/**
 * Read the interventions conversation's linkage for the Interventions
 * hub: the thread's id (the stable `/chat?c=` return link) and which
 * proposals it carries at each lifecycle step. Null when no
 * interventions conversation exists.
 */
export async function interventionsChatLinkage(
  ctx: TenantContext,
): Promise<InterventionsChatLinkage | null> {
  const conversation = await findInterventionsConversation(ctx);
  if (conversation === null) return null;
  const messages = await listMessages(ctx, {
    conversationId: conversation.id,
    order: 'desc',
    limit: SWEEP_WINDOW,
  });
  const recommendationProposalIds: string[] = [];
  const decidedProposalIds: string[] = [];
  const activatedProposalIds: string[] = [];
  for (const message of messages) {
    const id = message.providerMessageId;
    if (id === null) continue;
    if (id.startsWith(INTERVENTION_REC_PREFIX)) {
      recommendationProposalIds.push(id.slice(INTERVENTION_REC_PREFIX.length));
    } else if (id.startsWith(INTERVENTION_OUTCOME_PREFIX)) {
      decidedProposalIds.push(id.slice(INTERVENTION_OUTCOME_PREFIX.length));
    } else if (id.startsWith(INTERVENTION_ACTIVATION_PREFIX)) {
      activatedProposalIds.push(id.slice(INTERVENTION_ACTIVATION_PREFIX.length));
    }
  }
  return {
    conversationId: conversation.id,
    recommendationProposalIds: [...new Set(recommendationProposalIds)],
    decidedProposalIds: [...new Set(decidedProposalIds)],
    activatedProposalIds: [...new Set(activatedProposalIds)],
  };
}

/** The stable return link into the interventions conversation (W072 seam). */
export function interventionsChatHref(linkage: InterventionsChatLinkage): string {
  return chatConversationHref(linkage.conversationId);
}
