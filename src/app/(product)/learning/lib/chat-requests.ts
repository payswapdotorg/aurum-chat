// Chat-based learning requests (W073) — the Learning module's domain-
// service glue that drives knowledge acquisition from the CONVERSATION.
//
// THE WORK ITEM (frozen plan §5 W073): "Move employee knowledge acquisition
// into the conversational experience." The employee completes a knowledge
// request where they already work — the Aurum chat — without discovering
// the Learning route first, while the Learning page stays the supporting
// detail surface with the SAME evidence chain.
//
// WHAT THIS MODULE ADDS (the W061 briefing-chat precedent, learning lane):
//
//   * ONE persistent "Aurum learning — knowledge requests" conversation
//     per tenant — found through the conversations contract (exact-title
//     match), created on first delivery;
//   * THE ASK — Aurum's proactive knowledge questions arrive as outbound
//     chat messages (left-aligned Aurum turns, WhatsApp-like): the open
//     ask-person acquisition plans (the SAME open feed the Learning hub
//     lists, oldest first) each become ONE message carrying a
//     knowledge-request card (the shared card model — chat-types' W073
//     learning kinds) plus the mission-progress card and evidence links;
//   * THE ANSWER — answerKnowledgeRequestInChat captures the employee's
//     thread reply through the SAME domain workflow the Learning surface
//     drives (answerKnowledgeRequest: capture → acknowledgement → reward
//     state → evidence — lib/answer.ts), then records the member's turn
//     and Aurum's acknowledgement reply in the same thread, so management
//     sees ONE evidence chain from both surfaces;
//   * THE ACKNOWLEDGEMENT — an embedded contribution card (status ladder)
//     plus the mission-progress card, reward/recognition state when the
//     policy produced any, the evidence citations (the immutable
//     observation + the mission), and the reward-separation sentence
//     (labels.ts — contribution/reward semantics stay separate from
//     compensation/performance, lock 9 / ARCHITECTURE.md §8);
//   * CONVERGENCE — the delivery sweep also ensures the thread carries the
//     acknowledgement for already-answered asks (answered through the
//     Learning form or the loop), composing from LIVE domain state so
//     reward/recognition state surfaces conversationally there too.
//
// HONESTY RULES (the frozen invariants this composition lives under):
//   * the transcript is never a second source of truth (lock 10/34): every
//     message is DERIVED from domain records and deep-links into the
//     owning surfaces; answering drives the domain workflow, it never
//     writes domain state itself;
//   * no cognition execution is minted by delivery or acknowledgement:
//     there is no new reasoning — the plans already carry their
//     provenance, and the answer's evidence observation is recorded by
//     the W012 service exactly as the Learning surface records it;
//   * attribution (lock 15): the answering session's display name is the
//     audit actor — the DOMAIN still anchors the contribution to the
//     plan's chosen person;
//   * idempotency: provider message ids are `learning-ask-<planId>` /
//     `learning-answer-<planId>` / `learning-ack-<planId>` — one ask, one
//     answer turn and one acknowledgement per plan, ever (the
//     conversations contract's (tenant, channel, providerMessageId)
//     dedupe is the final guard; the domain's one-outcome-per-plan is
//     the first).

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
import { getMission } from '@/modules/missions/contract';
import type { Mission } from '@/modules/missions/contract';
import {
  getAcquisitionPlan,
  listAcquisitionPlans,
} from '@/modules/knowledge-acquisition/contract';
import type { AcquisitionPlan } from '@/modules/knowledge-acquisition/contract';
import { listContributions } from '@/modules/contributions/contract';
import type { Contribution } from '@/modules/contributions/contract';
import { listRewards } from '@/modules/rewards/contract';
import type { Reward } from '@/modules/rewards/contract';
import type {
  ChatAnswer,
  ChatCard,
  ChatCardContext,
  ChatCitation,
  ChatTurnPayload,
} from '../../chat/lib/chat-types';
import { chatConversationHref } from '../../chat/lib/chat-types';
import { answerKnowledgeRequest, LearningStateError } from './answer';
import { validateAnswerInput } from './form';
import type { AnswerStrength } from './form';
import type { ValidatedAnswerInput } from './form';
import {
  REWARD_SEPARATION_NOTE,
  askPolicyNote,
  contributionStatusExplanation,
  contributionStatusLabel,
  contributionStatusTone,
  dateLabel,
  missionProgressPercent,
  moneyLabel,
  percentLabel,
  rewardKindLabel,
  rewardStatusLabel,
  rewardStatusTone,
} from './labels';

// ---------------------------------------------------------------------------
// The persistent learning conversation
// ---------------------------------------------------------------------------

/** The persistent learning thread's title (the find-or-create key). */
export const LEARNING_CONVERSATION_TITLE = 'Aurum learning — knowledge requests';

/** The provider-message-id prefixes (per-plan idempotency keys). */
export const LEARNING_ASK_PREFIX = 'learning-ask-';
export const LEARNING_ANSWER_PREFIX = 'learning-answer-';
export const LEARNING_ACK_PREFIX = 'learning-ack-';

/** How many open requests one delivery sweep asks (oldest first). */
export const ASK_DELIVERY_LIMIT = 5;

/** How many already-answered asks one sweep converges (newest first). */
export const ACK_ENSURE_LIMIT = 3;

/** The recent-message window the sweep scans for delivered ids. */
export const SWEEP_WINDOW = 200;

/** The provider message id of one plan's ask message. */
export function askProviderMessageId(planId: string): string {
  return `${LEARNING_ASK_PREFIX}${planId}`;
}

/** The provider message id of one plan's member-answer turn. */
export function answerProviderMessageId(planId: string): string {
  return `${LEARNING_ANSWER_PREFIX}${planId}`;
}

/** The provider message id of one plan's acknowledgement message. */
export function acknowledgementProviderMessageId(planId: string): string {
  return `${LEARNING_ACK_PREFIX}${planId}`;
}

/**
 * Find the tenant's persistent learning conversation (exact-title match
 * over the bounded titleContains read), or null when there is none.
 */
export async function findLearningConversation(
  ctx: TenantContext,
): Promise<Conversation | null> {
  const candidates = await listConversations(ctx, {
    titleContains: LEARNING_CONVERSATION_TITLE,
    limit: 50,
  });
  return (
    candidates.find((conversation) => conversation.title === LEARNING_CONVERSATION_TITLE) ??
    null
  );
}

/** Find or create the persistent learning conversation. */
export async function ensureLearningConversation(ctx: TenantContext): Promise<Conversation> {
  const existing = await findLearningConversation(ctx);
  if (existing !== null) return existing;
  return createConversation(ctx, { title: LEARNING_CONVERSATION_TITLE });
}

// ---------------------------------------------------------------------------
// Pure presentation helpers (the unit-test seam)
// ---------------------------------------------------------------------------

function clip(text: string, bound: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= bound ? flat : `${flat.slice(0, bound - 1)}…`;
}

/** Who the planner chose to ask (the asked-of label, views.ts discipline). */
export function askedOfLabel(plan: AcquisitionPlan): string {
  return plan.chosen?.label ?? plan.chosen?.id ?? 'the selected source';
}

/** The mission progress line shared by the ask and acknowledgement cards. */
export function missionProgressLine(mission: Mission): string {
  const percent = missionProgressPercent(
    mission.content.currentConfidence,
    mission.content.targetConfidence,
  );
  return `Confidence ${percentLabel(mission.content.currentConfidence)} of ${percentLabel(
    mission.content.targetConfidence,
  )} — ${percent}% toward target`;
}

/** The knowledge-request card (the shared card model, W073 learning kind). */
export function knowledgeRequestCard(plan: AcquisitionPlan, mission: Mission): ChatCard {
  const askedOf = askedOfLabel(plan);
  const context: ChatCardContext = {
    subtitle: 'A targeted knowledge request — Aurum needs what you know',
    sections: [
      {
        kind: 'why',
        title: 'Why this matters',
        lines: [clip(mission.content.knowledgeObjective, 400)],
        links: [],
      },
      {
        kind: 'mission',
        title: 'The learning mission',
        lines: [
          missionProgressLine(mission),
          `Reward budget ${moneyLabel(
            mission.content.rewardBudget.amount,
            mission.content.rewardBudget.currency,
          )}`,
        ],
        links: [
          { label: 'Open the learning mission', href: `/intelligence/missions/${mission.id}` },
        ],
      },
      {
        kind: 'policy',
        title: 'Ask policy',
        lines: [
          plan.askPolicy === null
            ? 'The ask was recorded without a person-policy evaluation.'
            : askPolicyNote(plan.askPolicy.outcome),
        ],
        links: [],
      },
      {
        kind: 'evidence',
        title: 'What answering does',
        lines: [
          'Your reply is recorded as an immutable observation and acknowledged as a contribution.',
        ],
        links: [{ label: 'Open the Evidence surface', href: '/evidence' }],
      },
    ],
  };
  return {
    kind: 'knowledge-request',
    id: plan.id,
    title: clip(plan.question ?? '(the planner recorded no question)', 300),
    statusLabel: 'Awaiting an answer',
    tone: 'info',
    meta: [
      `Asked of ${askedOf}`,
      `Mission: ${clip(mission.content.title, 120)}`,
      missionProgressLine(mission),
      `Planned ${dateLabel(plan.recordedAt)}`,
    ],
    href: '/learning',
    linkLabel: 'Open the Learning surface',
    decision: null,
    context,
  };
}

/** The mission-progress card (the existing mission kind, live progress). */
export function missionProgressCard(mission: Mission): ChatCard {
  const meta: string[] = [
    missionProgressLine(mission),
    `Reward budget ${moneyLabel(
      mission.content.rewardBudget.amount,
      mission.content.rewardBudget.currency,
    )}`,
  ];
  if (mission.content.rewardTerms !== null) {
    meta.push(`Promised: ${clip(mission.content.rewardTerms, 200)}`);
  }
  return {
    kind: 'mission',
    id: mission.id,
    title: clip(mission.content.title, 160),
    statusLabel: `${mission.content.urgency} urgency`,
    tone: mission.content.urgency === 'critical' ? 'error' : mission.content.urgency === 'high' ? 'warning' : 'info',
    meta,
    href: `/intelligence/missions/${mission.id}`,
    linkLabel: 'Open the learning mission',
    decision: null,
    context: {
      subtitle: 'The mission this knowledge request serves',
      sections: [
        {
          kind: 'why',
          title: 'Why this matters',
          lines: [clip(mission.content.knowledgeObjective, 400)],
          links: [],
        },
        {
          kind: 'evidence',
          title: 'Evidence',
          lines: ['The mission’s acquisition trail records every planner decision and answer.'],
          links: [{ label: 'Open the Learning surface', href: '/learning' }],
        },
      ],
    },
  };
}

/** The contribution acknowledgement card (W073 learning kind). */
export function contributionCard(contribution: Contribution, missionTitle: string): ChatCard {
  const meta: string[] = [
    `Question: ${clip(contribution.question, 200)}`,
    `Contributed by ${contribution.contributor.label ?? 'an employee'}`,
    `Recorded ${dateLabel(contribution.recordedAt)}`,
    `Evidence observation ${contribution.evidenceObservationId.slice(0, 8)}`,
  ];
  if (contribution.validation !== null) {
    meta.push(
      `Assessed ${contribution.validation.outcome} — quality ${percentLabel(
        contribution.validation.quality,
      )}`,
    );
  }
  if (contribution.impact !== null) {
    meta.push(
      `Knowledge gain ${percentLabel(contribution.impact.knowledgeGain)} (confidence ${percentLabel(
        contribution.impact.confidenceBefore,
      )} → ${percentLabel(contribution.impact.confidenceAfter)})`,
    );
  }
  return {
    kind: 'contribution',
    id: contribution.id,
    title: `Contribution to ${missionTitle}`,
    statusLabel: contributionStatusLabel(contribution.status),
    tone: contributionStatusTone(contribution.status),
    meta,
    href: '/learning',
    linkLabel: 'Open the Learning surface',
    decision: null,
    context: {
      subtitle: 'Your answer, acknowledged',
      sections: [
        {
          kind: 'evidence',
          title: 'Evidence',
          lines: [clip(contribution.summary, 400)],
          links: [{ label: 'Open the Evidence surface', href: '/evidence' }],
        },
        {
          kind: 'detail',
          title: 'What this means',
          lines: [contributionStatusExplanation(contribution.status)],
          links: [],
        },
        {
          kind: 'policy',
          title: 'Rewards',
          lines: [REWARD_SEPARATION_NOTE],
          links: [{ label: 'Open the Learning surface', href: '/learning' }],
        },
      ],
    },
  };
}

/** The reward/recognition state card (W073 learning kind). */
export function rewardStateCard(reward: Reward, missionTitle: string): ChatCard {
  const meta: string[] = [
    reward.tier.amount === 0
      ? 'Recognition — no amount attached'
      : `Amount ${moneyLabel(reward.tier.amount, reward.tier.currency)}`,
    `Value score ${percentLabel(reward.valueScore)}`,
    `Mission: ${clip(missionTitle, 120)}`,
    `Recorded ${dateLabel(reward.recordedAt)}`,
  ];
  if (reward.status === 'proposed') {
    meta.push('The human approval gate holds this reward.');
  }
  return {
    kind: 'reward',
    id: reward.id,
    title: `${rewardKindLabel(reward.tier.kind)} — ${reward.tier.name}`,
    statusLabel: rewardStatusLabel(reward.status),
    tone: rewardStatusTone(reward.status),
    meta,
    href: '/learning',
    linkLabel: 'Open the Learning surface',
    decision: null,
    context: {
      subtitle: 'Recognition under the company’s explicit reward policy',
      sections: [
        {
          kind: 'policy',
          title: 'What a reward is',
          lines: [REWARD_SEPARATION_NOTE],
          links: [],
        },
        {
          kind: 'mission',
          title: 'The learning mission',
          lines: [],
          links: [{ label: 'Open the learning mission', href: `/intelligence/missions/${reward.missionId}` }],
        },
      ],
    },
  };
}

/** The evidence citations of one acknowledgement (the evidence chain). */
export function acknowledgementCitations(
  evidenceObservationId: string | null,
  mission: Mission,
): ChatCitation[] {
  const citations: ChatCitation[] = [];
  if (evidenceObservationId !== null && evidenceObservationId !== '') {
    citations.push({
      kind: 'observation',
      id: evidenceObservationId,
      label: `Your answer, recorded as evidence (${evidenceObservationId.slice(0, 8)})`,
      detail: 'The immutable observation this acknowledgement is anchored to',
      href: '/evidence',
    });
  }
  citations.push({
    kind: 'mission',
    id: mission.id,
    label: `Learning mission — ${clip(mission.content.title, 100)}`,
    detail: clip(mission.content.knowledgeObjective, 200),
    href: `/intelligence/missions/${mission.id}`,
  });
  return citations;
}

/** Render the ask text (Aurum speaking first, WhatsApp-like). */
export function renderAskText(plan: AcquisitionPlan, mission: Mission): string {
  const question = plan.question ?? '(the planner recorded no question)';
  return [
    `A knowledge request for “${clip(mission.content.title, 120)}” — the planner chose to ask ${askedOfLabel(plan)}:`,
    `“${clip(question, 400)}”`,
    'Answer right here in this conversation — your reply is recorded as evidence for the mission and acknowledged as a contribution.',
  ].join('\n\n');
}

/** Render the fresh-answer acknowledgement text (the same thread). */
export function renderAnswerAcknowledgementText(
  mission: Mission,
  contribution: Contribution | null,
): string {
  const title = clip(mission.content.title, 120);
  if (contribution === null) {
    return renderAnsweredStateText(mission, null);
  }
  return [
    `Thank you — your answer is recorded for “${title}”.`,
    `It is now immutable evidence, and your contribution is acknowledged (${contributionStatusLabel(
      contribution.status,
    )}). ${contributionStatusExplanation(contribution.status)}`,
    mission.content.rewardTerms === null
      ? 'Any reward follows the company’s explicit reward policy.'
      : `The mission promises: ${clip(mission.content.rewardTerms, 200)}. ${REWARD_SEPARATION_NOTE}`,
  ].join('\n\n');
}

/** Render the converged answered-state text (records, never re-asks). */
export function renderAnsweredStateText(mission: Mission, contribution: Contribution | null): string {
  const lines = [
    `This knowledge request has an answer — recorded as evidence for “${clip(
      mission.content.title,
      120,
    )}”.`,
  ];
  if (contribution === null) {
    lines.push('The same chain lives in the Learning surface.');
  } else {
    lines.push(
      `The contribution is ${contributionStatusLabel(contribution.status).toLowerCase()}. ${contributionStatusExplanation(
        contribution.status,
      )}`,
    );
    if (contribution.impact !== null) {
      lines.push(
        `Measured: knowledge gain ${percentLabel(contribution.impact.knowledgeGain)} (confidence ${percentLabel(
          contribution.impact.confidenceBefore,
        )} → ${percentLabel(contribution.impact.confidenceAfter)}).`,
      );
    }
    lines.push(REWARD_SEPARATION_NOTE);
  }
  return lines.join('\n\n');
}

/** The ask message's answer payload (cards + citations, shared model). */
export function askAnswer(plan: AcquisitionPlan, mission: Mission): ChatAnswer {
  return {
    intent: 'learning',
    mode: 'deterministic',
    headline: `A knowledge request for “${clip(mission.content.title, 120)}”`,
    bullets: [
      `Asked of ${askedOfLabel(plan)}`,
      missionProgressLine(mission),
      plan.askPolicy === null ? 'No person ask-policy evaluation recorded' : askPolicyNote(plan.askPolicy.outcome),
    ],
    note: null,
    cards: [knowledgeRequestCard(plan, mission), missionProgressCard(mission)],
    citations: [
      {
        kind: 'mission',
        id: mission.id,
        label: `Learning mission — ${clip(mission.content.title, 100)}`,
        detail: clip(mission.content.knowledgeObjective, 200),
        href: `/intelligence/missions/${mission.id}`,
      },
    ],
    executionId: null,
  };
}

/** The acknowledgement message's answer payload (the thread's record). */
export function acknowledgementAnswer(input: {
  mission: Mission;
  contribution: Contribution | null;
  evidenceObservationId: string | null;
  rewards: Reward[];
  fresh: boolean;
}): ChatAnswer {
  const { mission, contribution, evidenceObservationId, rewards, fresh } = input;
  const title = clip(mission.content.title, 120);
  const cards: ChatCard[] = [];
  if (contribution !== null) {
    cards.push(contributionCard(contribution, title));
  }
  cards.push(missionProgressCard(mission));
  for (const reward of rewards.slice(0, 2)) {
    cards.push(rewardStateCard(reward, title));
  }
  const bullets: string[] = [missionProgressLine(mission)];
  if (contribution !== null) {
    bullets.push(contributionStatusLabel(contribution.status));
  }
  if (rewards.length > 0) {
    bullets.push(
      `${rewards.length} reward${rewards.length === 1 ? '' : 's'} recorded under the explicit policy`,
    );
  }
  return {
    intent: 'learning',
    mode: 'deterministic',
    headline: fresh
      ? `Thank you — your answer is recorded for “${title}”.`
      : `This knowledge request is answered — “${title}”.`,
    bullets,
    note: null,
    cards,
    citations: acknowledgementCitations(evidenceObservationId, mission),
    executionId: null,
  };
}

// ---------------------------------------------------------------------------
// The delivery sweep (the proactive ask + convergence)
// ---------------------------------------------------------------------------

/** What one delivery sweep produced. */
export interface LearningChatDelivery {
  ok: true;
  /** True when NEW messages were recorded this call. */
  delivered: boolean;
  /** The persistent learning conversation (null when none was needed). */
  conversationId: string | null;
  /** Open knowledge requests found (the full open feed, pre-limit). */
  openCount: number;
  /** Ask messages recorded this sweep. */
  asksRecorded: number;
  /** Open requests already in the thread (skipped). */
  asksDeduped: number;
  /** Acknowledgements recorded this sweep (converged answered asks). */
  acksRecorded: number;
  /** Which plan ids now have an ask in the thread. */
  askPlanIds: string[];
}

/** Why a sweep did not happen (honest, never silent). */
export type LearningChatDeliveryRefusal = { ok: false; reason: 'reads_unavailable' };

/** The open ask feed the sweep delivers (the hub's own discipline). */
async function openAskPlans(
  ctx: TenantContext,
): Promise<AcquisitionPlan[]> {
  const plans = await listAcquisitionPlans(ctx, { action: 'ask-person', limit: 100 });
  const open = plans.filter(
    (plan) => plan.decision === 'selected' && plan.outcome === null && plan.question !== null,
  );
  open.sort((left, right) => left.recordedAt.localeCompare(right.recordedAt));
  return open;
}

/** Recently answered ask-person plans (the convergence candidates). */
async function answeredAskPlans(ctx: TenantContext): Promise<AcquisitionPlan[]> {
  const plans = await listAcquisitionPlans(ctx, { action: 'ask-person', limit: 100 });
  const answered = plans.filter(
    (plan) =>
      plan.decision === 'selected' &&
      plan.action === 'ask-person' &&
      plan.outcome !== null &&
      plan.outcome.outcome === 'answered' &&
      plan.question !== null,
  );
  answered.sort((left, right) => right.recordedAt.localeCompare(left.recordedAt));
  return answered;
}

/** Find the contribution anchored to one plan (bounded, null when none). */
export async function contributionForPlan(
  ctx: TenantContext,
  plan: AcquisitionPlan,
): Promise<Contribution | null> {
  const contributions = await listContributions(ctx, { missionId: plan.missionId, limit: 50 });
  return contributions.find((contribution) => contribution.planId === plan.id) ?? null;
}

/** Record one acknowledgement turn for a plan (idempotent by provider id). */
async function recordAcknowledgement(
  ctx: TenantContext,
  conversationId: string,
  plan: AcquisitionPlan,
  fresh: boolean,
): Promise<Message> {
  const mission = await getMission(ctx, plan.missionId);
  const contribution = await contributionForPlan(ctx, plan);
  const rewards = await listRewards(ctx, { missionId: plan.missionId, limit: 10 });
  const answer = acknowledgementAnswer({
    mission,
    contribution,
    evidenceObservationId: plan.outcome?.evidenceObservationId ?? null,
    rewards: contribution === null ? [] : rewards,
    fresh,
  });
  const text = fresh
    ? renderAnswerAcknowledgementText(mission, contribution)
    : renderAnsweredStateText(mission, contribution);
  return recordMessage(ctx, {
    conversationId,
    direction: 'outbound',
    actor: { kind: 'system', label: 'Aurum' },
    channel: 'web',
    payload: { text, starterId: null, answer } satisfies ChatTurnPayload,
    sentAt: now().toISOString(),
    providerMessageId: acknowledgementProviderMessageId(plan.id),
  });
}

/**
 * Deliver the tenant's open knowledge requests into the persistent
 * learning conversation, and converge the thread with acknowledgements
 * for asks that have since been answered. One ask message per open plan
 * (idempotent forever), one acknowledgement per answered plan — the
 * transcript mirrors the domain, never the reverse.
 */
export async function deliverKnowledgeRequestsToChat(
  ctx: TenantContext,
): Promise<LearningChatDelivery | LearningChatDeliveryRefusal> {
  let open: AcquisitionPlan[];
  let answered: AcquisitionPlan[];
  try {
    [open, answered] = await Promise.all([openAskPlans(ctx), answeredAskPlans(ctx)]);
  } catch {
    return { ok: false, reason: 'reads_unavailable' };
  }

  // Nothing to deliver and no thread to converge: no conversation is
  // created (a tenant whose asks were all answered before any chat
  // delivery never gets an empty thread).
  const existing = await findLearningConversation(ctx);
  if (open.length === 0 && existing === null) {
    return {
      ok: true,
      delivered: false,
      conversationId: null,
      openCount: 0,
      asksRecorded: 0,
      asksDeduped: 0,
      acksRecorded: 0,
      askPlanIds: [],
    };
  }

  const conversation = existing ?? (await ensureLearningConversation(ctx));

  // The idempotency window: which ask/ack provider ids the thread already
  // carries (bounded to the recent window; the contract's (tenant,
  // channel, providerMessageId) dedupe is the final guard either way).
  const recent = await listMessages(ctx, {
    conversationId: conversation.id,
    order: 'desc',
    limit: SWEEP_WINDOW,
  });
  const known = new Set(
    recent.map((message) => message.providerMessageId).filter((id): id is string => id !== null),
  );

  let asksRecorded = 0;
  let asksDeduped = 0;
  let acksRecorded = 0;
  const askPlanIds: string[] = [];

  for (const plan of open.slice(0, ASK_DELIVERY_LIMIT)) {
    const providerMessageId = askProviderMessageId(plan.id);
    if (known.has(providerMessageId)) {
      asksDeduped += 1;
      askPlanIds.push(plan.id);
      continue;
    }
    const mission = await getMission(ctx, plan.missionId);
    await recordMessage(ctx, {
      conversationId: conversation.id,
      direction: 'outbound',
      actor: { kind: 'system', label: 'Aurum' },
      channel: 'web',
      payload: {
        text: renderAskText(plan, mission),
        starterId: null,
        answer: askAnswer(plan, mission),
      } satisfies ChatTurnPayload,
      sentAt: now().toISOString(),
      providerMessageId,
    });
    known.add(providerMessageId);
    askPlanIds.push(plan.id);
    asksRecorded += 1;
  }

  // Convergence: asks that were delivered once and have since been
  // answered (here or on the Learning surface) get their acknowledgement
  // turn recorded — composed from LIVE domain state, exactly once.
  for (const plan of answered.slice(0, ACK_ENSURE_LIMIT)) {
    const ackId = acknowledgementProviderMessageId(plan.id);
    if (known.has(ackId)) continue;
    const askDelivered = recent.some(
      (message) => message.providerMessageId === askProviderMessageId(plan.id),
    );
    if (!askDelivered) continue;
    await recordAcknowledgement(ctx, conversation.id, plan, false);
    known.add(ackId);
    acksRecorded += 1;
  }

  return {
    ok: true,
    delivered: asksRecorded > 0 || acksRecorded > 0,
    conversationId: conversation.id,
    openCount: open.length,
    asksRecorded,
    asksDeduped,
    acksRecorded,
    askPlanIds,
  };
}

// ---------------------------------------------------------------------------
// The answer workflow (capture from the thread)
// ---------------------------------------------------------------------------

/** What one chat answer produced (both paths carry the thread state). */
export type ChatAnswerOutcome =
  | {
      status: 'answered';
      conversationId: string;
      planId: string;
      missionId: string;
      missionTitle: string;
      evidenceObservationId: string;
      contribution: Contribution;
      /** The member's recorded turn (right-aligned, WhatsApp-like). */
      inbound: Message;
      /** Aurum's acknowledgement reply (left-aligned, cards + citations). */
      acknowledgement: Message;
    }
  | {
      status: 'already_answered';
      conversationId: string;
      planId: string;
      missionId: string;
      missionTitle: string;
      evidenceObservationId: string | null;
      contribution: Contribution | null;
      /** The member's original turn, when the answer came from chat. */
      inbound: Message | null;
      /** The acknowledgement now ensured in the thread. */
      acknowledgement: Message;
    };

/** One inline answer: which thread (null = the learning conversation). */
export interface ChatAnswerInput {
  conversationId: string | null;
  planId: string;
  summary: string;
  confidence: AnswerStrength;
}

/**
 * Answer one knowledge request FROM THE THREAD — the SAME domain workflow
 * the Learning surface drives (capture → acknowledgement → reward state →
 * evidence), then the member's turn and Aurum's acknowledgement land in
 * the same conversation. Contract errors propagate for the API layer
 * (`plan_not_found`, `request_state`, `invalid_answer_input` …); an
 * already-answered plan converges the thread instead of failing silently
 * (the acknowledgement is ensured, then the honest 409 outcome returns).
 */
export async function answerKnowledgeRequestInChat(
  ctx: TenantContext,
  input: ChatAnswerInput,
  answeringDisplayName: string,
): Promise<ChatAnswerOutcome> {
  const plan = await getAcquisitionPlan(ctx, input.planId);
  if (plan.decision !== 'selected' || plan.action !== 'ask-person' || plan.question === null) {
    throw new LearningStateError(
      'this plan carries no targeted person question — there is nothing to answer here',
    );
  }

  const conversation =
    input.conversationId === null
      ? await ensureLearningConversation(ctx)
      : await ensureConversationById(ctx, input.conversationId);
  const mission = await getMission(ctx, plan.missionId);
  const missionTitle = mission.content.title;

  // The fresh path: the domain workflow first (evidence observation +
  // contribution), then the transcript turns.
  if (plan.outcome === null) {
    const validated: ValidatedAnswerInput = validateAnswerInput({
      summary: input.summary,
      note: null,
      confidence: input.confidence,
    });
    const acknowledgement = await answerKnowledgeRequest(
      ctx,
      input.planId,
      validated,
      answeringDisplayName,
    );
    // The member's turn — honest 'external' attribution (lock 15), the
    // web channel, idempotent per plan (one answer turn ever).
    const inbound = await recordMessage(ctx, {
      conversationId: conversation.id,
      direction: 'inbound',
      actor: { kind: 'external', label: answeringDisplayName },
      channel: 'web',
      payload: { text: input.summary, starterId: null, answer: null } satisfies ChatTurnPayload,
      sentAt: now().toISOString(),
      providerMessageId: answerProviderMessageId(input.planId),
    });
    // Re-read the plan: the acknowledgement composes from the ANSWERED
    // state (the fresh evidence observation id rides the citations).
    const refreshed = await getAcquisitionPlan(ctx, input.planId);
    const reply = await recordAcknowledgement(ctx, conversation.id, refreshed, true);
    return {
      status: 'answered',
      conversationId: conversation.id,
      planId: input.planId,
      missionId: plan.missionId,
      missionTitle,
      evidenceObservationId: acknowledgement.evidenceObservationId,
      contribution: acknowledgement.contribution,
      inbound,
      acknowledgement: reply,
    };
  }

  // The converged path: the outcome is terminal. An 'answered' plan
  // converges the thread (the acknowledgement is ensured from live
  // state) and reports the honest first-write-wins outcome; any other
  // terminal outcome is simply terminal.
  if (plan.outcome.outcome !== 'answered') {
    throw new LearningStateError(
      `this knowledge request was already ${plan.outcome.outcome} — its outcome is terminal`,
    );
  }
  const contribution = await contributionForPlan(ctx, plan);
  const recent = await listMessages(ctx, {
    conversationId: conversation.id,
    order: 'desc',
    limit: SWEEP_WINDOW,
  });
  const inbound =
    recent.find(
      (message) => message.providerMessageId === answerProviderMessageId(input.planId),
    ) ?? null;
  const acknowledgement = await recordAcknowledgement(ctx, conversation.id, plan, false);
  return {
    status: 'already_answered',
    conversationId: conversation.id,
    planId: input.planId,
    missionId: plan.missionId,
    missionTitle,
    evidenceObservationId: plan.outcome.evidenceObservationId,
    contribution,
    inbound,
    acknowledgement,
  };
}

async function ensureConversationById(
  ctx: TenantContext,
  conversationId: string,
): Promise<Conversation> {
  return getConversation(ctx, conversationId);
}

// ---------------------------------------------------------------------------
// The Learning surface's chat linkage (the return-link seam)
// ---------------------------------------------------------------------------

/** Which learning surface records also live in the learning conversation. */
export interface LearningChatLinkage {
  conversationId: string;
  /** Plan ids whose ask was delivered into the thread. */
  askPlanIds: string[];
  /** Contribution ids whose acknowledgement is in the thread. */
  acknowledgedContributionIds: string[];
}

/**
 * Read the learning conversation's linkage for the Learning surface: the
 * thread's id (the stable `/chat?c=` return link) and which asks /
 * acknowledgements it carries. Null when no learning conversation exists.
 */
export async function learningChatLinkage(
  ctx: TenantContext,
): Promise<LearningChatLinkage | null> {
  const conversation = await findLearningConversation(ctx);
  if (conversation === null) return null;
  const messages = await listMessages(ctx, {
    conversationId: conversation.id,
    order: 'desc',
    limit: SWEEP_WINDOW,
  });
  const askPlanIds: string[] = [];
  const acknowledgedContributionIds: string[] = [];
  for (const message of messages) {
    const id = message.providerMessageId;
    if (id === null) continue;
    if (id.startsWith(LEARNING_ASK_PREFIX)) {
      askPlanIds.push(id.slice(LEARNING_ASK_PREFIX.length));
    } else if (id.startsWith(LEARNING_ACK_PREFIX)) {
      const payload = message.payload;
      if (
        typeof payload === 'object' &&
        payload !== null &&
        !Array.isArray(payload) &&
        'answer' in payload
      ) {
        const answer = (payload as { answer?: unknown }).answer;
        if (
          typeof answer === 'object' &&
          answer !== null &&
          !Array.isArray(answer) &&
          'cards' in answer &&
          Array.isArray((answer as { cards?: unknown }).cards)
        ) {
          for (const card of (answer as { cards: unknown[] }).cards) {
            if (
              typeof card === 'object' &&
              card !== null &&
              (card as { kind?: unknown }).kind === 'contribution' &&
              typeof (card as { id?: unknown }).id === 'string'
            ) {
              acknowledgedContributionIds.push((card as { id: string }).id);
            }
          }
        }
      }
    }
  }
  return {
    conversationId: conversation.id,
    askPlanIds: [...new Set(askPlanIds)],
    acknowledgedContributionIds: [...new Set(acknowledgedContributionIds)],
  };
}

/** The stable return link into the learning conversation (W072 seam). */
export function learningChatHref(linkage: LearningChatLinkage): string {
  return chatConversationHref(linkage.conversationId);
}
