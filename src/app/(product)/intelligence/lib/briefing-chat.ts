// Intelligence discovery (W061) — proactive findings delivery into chat.
//
// THE ACCEPTANCE: "proactive findings enter chat and Today". The findings
// (lib/findings.ts) are what Aurum found WITHOUT being asked; this module
// is the delivery half that lets them ENTER THE CONVERSATION — the
// WhatsApp-like behavior of an employee who messages you first:
//
//   * ONE persistent "Aurum intelligence" conversation per tenant — found
//     through the conversations contract (exact-title match over the
//     titleContains read), created on first delivery;
//   * ONE outbound transcript turn per findings STATE — the message
//     payload is the W060 answer shape (headline/bullets/cards/citations),
//     so the existing chat timeline renders the briefing with action
//     cards and evidence citations, no new renderer needed;
//   * IDEMPOTENT BY DIGEST — the provider message id is
//     `intel-briefing-<digest>` where the digest is a deterministic hash
//     of the finding identities: re-delivering an unchanged findings
//     state is a no-op (detected up-front by comparing the thread's last
//     turn), and NEW findings produce a NEW message. The conversations
//     contract's (tenant, channel, providerMessageId) dedupe is the final
//     guard.
//
// Honesty notes (the frozen invariants this composition lives under):
//   * the message is DERIVED intelligence, never authoritative state
//     (lock 34): the cards and citations all carry deep links into the
//     owning surfaces, and no belief/goal/unknown is created by delivery;
//   * the outbound turn is recorded as what Aurum actually said, exactly
//     like the W060 reply path records its answers — the transcript never
//     becomes a second source of truth (lock 10, ADR-0014);
//   * no cognition execution is minted BY THE DELIVERY itself: there is
//     no trigger message and no new reasoning — the findings already
//     carry their provenance (discovery runs, analysis traces), and the
//     cards deep-link to it.

import { now } from '@/infra/clock';
import type { TenantContext } from '@/infra/tenant';
import {
  createConversation,
  listConversations,
  listMessages,
  recordMessage,
} from '@/modules/conversations/contract';
import type { Conversation, Message } from '@/modules/conversations/contract';
import { buildProactiveFindings } from './findings';
import type { ProactiveFinding } from './findings';
import { findingChatCardKind } from './findings';
import { percentLine } from './findings';
import type {
  ChatAnswer,
  ChatCard,
  ChatCardContext,
  ChatCitation,
} from '../../chat/lib/chat-types';
import type { ChatTurnPayload } from '../../chat/lib/chat-types';

/** The persistent intelligence thread's title (the find-or-create key). */
export const INTELLIGENCE_CONVERSATION_TITLE = 'Aurum intelligence — findings';

/** The provider-message-id prefix for briefing deliveries (dedupe key). */
export const BRIEFING_MESSAGE_PREFIX = 'intel-briefing-';

// ---------------------------------------------------------------------------
// The digest (pure — the unit-test seam)
// ---------------------------------------------------------------------------

/**
 * Deterministic 64-bit FNV-1a-style fold over the finding identities
 * (sorted first, so the digest identifies the SET, not the order), rendered
 * as 16 hex chars. Not cryptographic — it is a stable identity for "this
 * exact set of findings", nothing more.
 */
export function findingsDigest(findings: readonly ProactiveFinding[]): string {
  const identities = findings
    .map((finding) => `${finding.source}:${finding.kind}:${finding.id}`)
    .sort();
  let hash = 0xcbf29ce484222325n;
  for (const identity of identities) {
    for (const part of identity) {
      hash ^= BigInt(part.charCodeAt(0));
      hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
    }
  }
  return hash.toString(16).padStart(16, '0');
}

/** The provider message id for one findings state. */
export function briefingProviderMessageId(digest: string): string {
  return `${BRIEFING_MESSAGE_PREFIX}${digest}`;
}

// ---------------------------------------------------------------------------
// The briefing answer (pure — the chat payload composition)
// ---------------------------------------------------------------------------

/** The affordance label on proactive cards (W061's product-mode links). */
export const FINDING_CARD_LINK_LABEL = 'Open the intelligence workflow';

function findingContext(finding: ProactiveFinding): ChatCardContext {
  const sections: ChatCardContext['sections'] = [
    {
      kind: 'why',
      title: 'Why this matters',
      lines: [finding.whyThisMatters],
      links: [],
    },
    {
      kind: 'detail',
      title: 'What Aurum needs next',
      lines: [finding.whatNext],
      links:
        finding.missionId === null
          ? []
          : [
              {
                label: 'Open the learning mission',
                href: `/intelligence/missions/${finding.missionId}`,
              },
            ],
    },
  ];
  if (finding.evidenceObservationIds.length > 0) {
    sections.push({
      kind: 'evidence',
      title: 'Evidence',
      lines: [`${finding.evidenceObservationIds.length} observation(s) underpin this finding`],
      links: [{ label: 'Open the Evidence surface', href: '/evidence' }],
    });
  }
  if (finding.affectedGoalIds.length > 0) {
    sections.push({
      kind: 'related-goal',
      title: 'Related goal',
      lines: [],
      links: finding.affectedGoalIds
        .slice(0, 3)
        .map((goalId) => ({
          label: 'Open the goal chain',
          href: `/intelligence/goals/${goalId}`,
        })),
    });
  }
  return { subtitle: 'Proactive finding — Aurum found this on its own', sections };
}

/** One proactive finding as a chat action card (the W060 seven-kind set). */
export function findingCard(finding: ProactiveFinding): ChatCard {
  const meta: string[] = [
    finding.severity.label,
    percentLine(finding.impact, 'Decision impact'),
    percentLine(finding.informationValue, 'Information value'),
  ].filter((line): line is string => line !== null);
  return {
    kind: findingChatCardKind(finding.kind),
    id: finding.id,
    title: finding.title,
    statusLabel: finding.severity.label,
    tone: finding.severity.tone,
    meta,
    href: finding.href,
    linkLabel: FINDING_CARD_LINK_LABEL,
    decision: null,
    context: findingContext(finding),
  };
}

/** The evidence citations of a findings state (bounded, deduplicated). */
export function findingCitations(findings: readonly ProactiveFinding[]): ChatCitation[] {
  const seen = new Set<string>();
  const citations: ChatCitation[] = [];
  for (const finding of findings) {
    for (const observationId of finding.evidenceObservationIds) {
      if (seen.has(observationId)) continue;
      seen.add(observationId);
      citations.push({
        kind: 'observation',
        id: observationId,
        label: `Observation ${observationId.slice(0, 8)}`,
        detail: 'Evidence underpinning a proactive finding',
        href: '/evidence',
      });
      if (citations.length >= 4) return citations;
    }
  }
  return citations;
}

/** Render the deterministic briefing text (Aurum speaking first). */
export function renderBriefingText(findings: readonly ProactiveFinding[]): string {
  if (findings.length === 0) {
    return 'I looked over the company on my own — nothing needs your attention right now.';
  }
  const lines: string[] = [
    `I found ${findings.length === 1 ? 'one thing' : `${findings.length} things`} on my own — here is Today's briefing, worst first:`,
  ];
  for (const finding of findings.slice(0, 5)) {
    lines.push(`• ${finding.severity.label} — ${finding.title}`);
  }
  if (findings.length > 5) {
    lines.push(`• …and ${findings.length - 5} more on the Intelligence surface`);
  }
  return lines.join('\n');
}

/** Compose the briefing answer payload (pure). */
export function briefingAnswer(
  findings: readonly ProactiveFinding[],
  degraded: readonly string[],
): ChatAnswer {
  const note =
    degraded.length === 0
      ? null
      : `Some reads were unavailable just now (${degraded.join(', ')}) — this briefing may be incomplete.`;
  return {
    intent: 'attention',
    mode: 'deterministic',
    headline:
      findings.length === 0
        ? 'Nothing needs your attention right now.'
        : `Today's briefing — ${findings.length === 1 ? 'one proactive finding' : `${findings.length} proactive findings`}, worst first.`,
    bullets: findings
      .slice(0, 5)
      .map((finding) => `${finding.severity.label}: ${finding.title}`),
    note,
    cards: findings.slice(0, 6).map(findingCard),
    citations: findingCitations(findings),
    executionId: null,
  };
}

// ---------------------------------------------------------------------------
// The delivery (contract writes, idempotent by digest)
// ---------------------------------------------------------------------------

/** What one delivery produced. */
export interface BriefingDelivery {
  /** Discriminator (the refusal side carries ok: false). */
  ok: true;
  /** True when a NEW message was recorded this call. */
  delivered: boolean;
  /** True when the identical findings state was already in the thread. */
  deduped: boolean;
  /** The persistent intelligence conversation (created when missing). */
  conversationId: string;
  /** The briefing message (the existing one when deduped). */
  messageId: string | null;
  /** The digest of the delivered findings state. */
  digest: string;
  /** How many findings the briefing carries. */
  findingCount: number;
}

/** Why a delivery did not happen (honest outcomes, never silent). */
export type DeliveryRefusal = { ok: false; reason: 'conversation_unavailable' };

/**
 * Find the tenant's persistent intelligence conversation (exact-title
 * match over the bounded titleContains read), or null when there is none.
 */
export async function findIntelligenceConversation(
  ctx: TenantContext,
): Promise<Conversation | null> {
  const candidates = await listConversations(ctx, {
    titleContains: INTELLIGENCE_CONVERSATION_TITLE,
    limit: 50,
  });
  return (
    candidates.find(
      (conversation) => conversation.title === INTELLIGENCE_CONVERSATION_TITLE,
    ) ?? null
  );
}

/**
 * Deliver the tenant's current proactive findings into the chat — ONE
 * outbound turn in the persistent intelligence conversation, idempotent
 * per findings digest. An EMPTY findings state is delivered once, as the
 * honest "I looked over the company — nothing needs your attention"
 * turn (the digest keeps it from ever repeating); re-delivering an
 * UNCHANGED state is a no-op, and only NEW findings produce a NEW turn.
 */
export async function deliverFindingsToChat(
  ctx: TenantContext,
): Promise<BriefingDelivery | DeliveryRefusal> {
  const composed = await buildProactiveFindings(ctx);
  const findings = composed.findings;
  const digest = findingsDigest(findings);

  // Find or create the persistent intelligence thread.
  let conversation: Conversation;
  try {
    const existing = await findIntelligenceConversation(ctx);
    conversation =
      existing ??
      (await createConversation(ctx, {
        title: INTELLIGENCE_CONVERSATION_TITLE,
      }));
  } catch {
    return { ok: false, reason: 'conversation_unavailable' };
  }

  // Idempotency: the identical findings state is already the thread's
  // latest turn → no new message (re-delivering unchanged state is a
  // no-op, not a duplicate).
  const providerMessageId = briefingProviderMessageId(digest);
  const latest = await listMessages(ctx, {
    conversationId: conversation.id,
    order: 'desc',
    limit: 1,
  });
  const last = latest[0] ?? null;
  if (last !== null && last.providerMessageId === providerMessageId) {
    return {
      ok: true,
      delivered: false,
      deduped: true,
      conversationId: conversation.id,
      messageId: last.id,
      digest,
      findingCount: findings.length,
    };
  }

  const answer = briefingAnswer(findings, composed.degraded);
  const payload: ChatTurnPayload = {
    text: renderBriefingText(findings),
    starterId: null,
    answer,
  };

  // An empty findings state still gets ONE honest "nothing needs
  // attention" turn (the digest keeps it from ever repeating).
  const message: Message = await recordMessage(ctx, {
    conversationId: conversation.id,
    direction: 'outbound',
    actor: { kind: 'system', label: 'Aurum' },
    channel: 'web',
    payload,
    sentAt: now().toISOString(),
    providerMessageId,
  });

  return {
    ok: true,
    delivered: true,
    deduped: false,
    conversationId: conversation.id,
    messageId: message.id,
    digest,
    findingCount: findings.length,
  };
}
