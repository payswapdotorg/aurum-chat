// Aurum chat (W060) — the chat workflow: one turn of the conversation,
// end to end, through the frozen domain contracts.
//
// WHAT HAPPENS ON A SEND (Journey B of the product-surface plan):
//
//   1. RECORD the member's turn (conversations W029 recordMessage —
//      inbound, channel 'web'). Attribution is HONEST: the signed-in
//      member is recorded as actor kind 'external' with their display
//      name — the conversations contract only attributes `person` through
//      a verified people record or a verified+linked channel identity
//      (ADR-0003/lock 15), and no contract maps an auth principal to a
//      person, so the transcript never fabricates person attribution.
//   2. START a cognitive execution (cognition W013 startExecution) with
//      trigger kind 'conversation' and causation kind
//      'conversation-message' — the turn IS a cycle of the canonical
//      loop — and LINK it to the transcript (role 'triggered').
//   3. PUMP the execution through ALL TWELVE canonical stages (lock 36 —
//      explicit, bounded, traceable): the member's message is recorded as
//      an immutable OBSERVATION (the cognition path's job, W013), the
//      answer's related goals feed goal-evaluation, and the outcome
//      stage records what the cycle concluded. No stage is skipped, no
//      content is fabricated: claims/unknowns/missions/findings/actions
//      are honestly none for a Q&A cycle — Aurum does not invent
//      organizational records to answer a chat question (lock 10).
//   4. COMPOSE the answer (answers.ts — deterministic, contract-read)
//      and render its text: through the LLM gateway (W034 invokeLlm,
//      scope 'conversation') when a transport AND a tenant account are
//      wired; deterministically otherwise. LLM text is presentation, not
//      authority — cards and citations always come from contracts.
//   5. RECORD the reply (outbound, actor system 'Aurum' — the demo-seed
//      precedent) with the full answer payload, and LINK it to the
//      execution (role 'produced').
//
// The transcript is never a second source of truth: no belief, goal or
// unknown is created by chatting (the conversations module's own
// discipline); the cycle's reasoning lives on the cognition trace.

import { now } from '@/infra/clock';
import type { TenantContext } from '@/infra/tenant';
import {
  getLlmTransport,
  invokeLlm,
} from '@/modules/llm/contract';
import type { LlmExecution } from '@/modules/llm/contract';
import { LlmError } from '@/modules/llm/contract';
import {
  runNextStage,
  startExecution,
} from '@/modules/cognition/contract';
import type { AdvanceExecutionInput } from '@/modules/cognition/contract';
import {
  recordExecutionLink,
  recordMessage,
} from '@/modules/conversations/contract';
import type { Message } from '@/modules/conversations/contract';
import {
  composeAnswer,
  deriveTopics,
  renderDeterministicText,
} from './answers';
import type { ComposedAnswer } from './answers';
import type { ChatAnswer, ChatTurnPayload } from './chat-types';
import { classifyIntent } from './answers';
import { MAX_CHAT_TEXT_LENGTH } from './chat-types';

/** The workflow's own error (code-carrying, like every module error). */
export type ChatWorkflowErrorCode =
  | 'invalid_text'
  | 'invalid_conversation'
  | 'workflow_failed';

export class ChatWorkflowError extends Error {
  readonly code: ChatWorkflowErrorCode;
  constructor(code: ChatWorkflowErrorCode, message: string) {
    super(message);
    this.name = 'ChatWorkflowError';
    this.code = code;
  }
}

/** Who is speaking (the session-resolved member). */
export interface ChatSpeaker {
  displayName: string;
}

/** One send: which thread (null = auto-create) and what text. */
export interface ChatTurnInput {
  conversationId: string | null;
  text: string;
  starterId: string | null;
  /**
   * Client-minted idempotency id for the inbound turn (retry-safe sends:
   * the conversations contract dedupes on provider message id per
   * (tenant, channel) — a replayed send replays the original row).
   */
  clientMessageId: string | null;
}

/** What one completed turn produced. */
export interface ChatTurnResult {
  conversationId: string;
  inbound: Message;
  reply: Message;
  /** The cognition execution that produced the answer (its trace id). */
  executionId: string;
  answer: ChatAnswer;
}

/** Validate composer text (1..4000 chars after trimming). */
export function validateChatText(text: unknown): string {
  if (typeof text !== 'string') {
    throw new ChatWorkflowError('invalid_text', 'the message text must be a string');
  }
  const trimmed = text.trim();
  if (trimmed === '') {
    throw new ChatWorkflowError('invalid_text', 'the message text must not be empty');
  }
  if (trimmed.length > MAX_CHAT_TEXT_LENGTH) {
    throw new ChatWorkflowError(
      'invalid_text',
      `the message text must be at most ${MAX_CHAT_TEXT_LENGTH} characters`,
    );
  }
  return trimmed;
}

/** Derive an honest auto-created-thread title from the first question. */
export function threadTitleFor(question: string): string {
  const flat = question.replace(/\s+/g, ' ').trim();
  return flat.length <= 60 ? flat : `${flat.slice(0, 59)}…`;
}

/** The observation kind a chat turn is recorded under (W004 vocabulary). */
export const CHAT_OBSERVATION_KIND = 'chat.message';

/** Render the reply text: LLM gateway when wired, deterministic otherwise. */
async function renderReplyText(
  ctx: TenantContext,
  question: string,
  composed: ComposedAnswer,
  inboundId: string,
): Promise<{ text: string; mode: 'deterministic' | 'llm'; llmExecutionId: string | null }> {
  const deterministic = renderDeterministicText(composed);
  // No transport wired (the default) → do not even mint a gate request:
  // the deterministic rendering is the honest mode, not a failure.
  if (getLlmTransport() === null) {
    return { text: deterministic, mode: 'deterministic', llmExecutionId: null };
  }
  try {
    const execution: LlmExecution = await invokeLlm(ctx, {
      capability: 'text-generation',
      scope: 'conversation',
      dataClassification: 'internal',
      messages: [
        { role: 'system', content: composed.llmContext.system },
        { role: 'user', content: composed.llmContext.user },
      ],
      temperature: 0.4,
      maxOutputTokens: 600,
      idempotencyKey: `chat:${inboundId}`,
    });
    if (execution.status === 'completed' && execution.result !== null) {
      const text =
        execution.result.kind === 'text-generation' ? execution.result.text.trim() : '';
      if (text !== '') {
        return { text, mode: 'llm', llmExecutionId: execution.id };
      }
    }
    return { text: deterministic, mode: 'deterministic', llmExecutionId: execution.id };
  } catch (error) {
    if (error instanceof LlmError) {
      // No eligible account, provider unavailable, gate refusal, budget —
      // every degradation path falls back to the deterministic rendering.
      return { text: deterministic, mode: 'deterministic', llmExecutionId: null };
    }
    throw error;
  }
}

/**
 * Run one full chat turn (the workflow above). Throws ChatWorkflowError
 * for input problems; contract errors propagate for the API layer to map.
 */
export async function runChatTurn(
  ctx: TenantContext,
  speaker: ChatSpeaker,
  input: ChatTurnInput,
): Promise<ChatTurnResult> {
  const text = validateChatText(input.text);
  const starterId =
    input.starterId !== null && input.starterId.trim() !== ''
      ? input.starterId.trim()
      : null;

  // 1 — the member's turn (immutable transcript record).
  const inbound = await recordMessage(ctx, {
    conversationId: input.conversationId,
    conversationTitle: input.conversationId === null ? threadTitleFor(text) : null,
    direction: 'inbound',
    // Honest attribution: no verified person linkage exists for an auth
    // principal (lock 15) — the transcript carries the display name.
    actor: { kind: 'external', label: speaker.displayName },
    channel: 'web',
    payload: { text, starterId } satisfies ChatTurnPayload,
    sentAt: now().toISOString(),
    providerMessageId:
      input.clientMessageId === null
        ? null
        : `web-${input.clientMessageId}`,
  });
  const conversationId = inbound.conversationId;

  // 2 — the cycle this turn triggers (W013), linked to the transcript.
  const intent = classifyIntent(text, starterId);
  const execution = await startExecution(ctx, {
    trigger: {
      kind: 'conversation',
      id: conversationId,
      label: `chat turn — ${threadTitleFor(text)}`,
    },
    focus: { topics: deriveTopics(text, starterId), entities: [] },
    actor: { kind: 'system', label: 'aurum-chat' },
    causation: { kind: 'conversation-message', id: inbound.id },
    rationale: `the member asked: ${threadTitleFor(text)}`,
  });
  await recordExecutionLink(ctx, {
    messageId: inbound.id,
    executionId: execution.id,
    role: 'triggered',
  });

  // 3 — compose the answer from live tenant state (contract reads).
  const composed = await composeAnswer(ctx, text, starterId);

  // 4 — pump the twelve canonical stages. The observation stage records
  // the member's message as immutable evidence; goal-evaluation carries
  // the answer's related goals; outcome records the cycle's conclusion.
  const advance = (step: AdvanceExecutionInput) => runNextStage(ctx, step);
  const observationStep = await advance({
    executionId: execution.id,
    stage: 'observation',
    record: [
      {
        kind: CHAT_OBSERVATION_KIND,
        payload: {
          conversationId,
          messageId: inbound.id,
          text,
          starterId,
        },
        observedAt: inbound.sentAt,
        source: { kind: 'external', id: null, label: speaker.displayName },
        channel: 'web',
        confidence: {
          value: 1,
          method: 'direct',
          basis: 'verbatim chat message from an authenticated member session',
        },
      },
    ],
  });
  const observationResult = observationStep.steps.find(
    (step) => step.stage === 'observation',
  )?.result;
  const turnObservationId =
    observationResult !== undefined && observationResult.stage === 'observation'
      ? (observationResult.observationIds[0] ?? null)
      : null;

  await advance({ executionId: execution.id, stage: 'evidence-memory' });
  await advance({ executionId: execution.id, stage: 'world-update', update: null });
  await advance({ executionId: execution.id, stage: 'epistemic-evaluation' });
  await advance({
    executionId: execution.id,
    stage: 'goal-evaluation',
    relatedGoalIds: composed.relatedGoalIds,
  });
  await advance({ executionId: execution.id, stage: 'unknown-mission-evaluation' });
  await advance({ executionId: execution.id, stage: 'knowledge-acquisition', missionId: null });
  await advance({ executionId: execution.id, stage: 'model-update', belief: null });
  await advance({
    executionId: execution.id,
    stage: 'risk-opportunity-capability-analysis',
  });
  await advance({
    executionId: execution.id,
    stage: 'recommendation-ask-proposal-action',
    action: null,
  });
  await advance({
    executionId: execution.id,
    stage: 'outcome',
    summary: `${intent} answer delivered — ${composed.headline}`,
  });
  await advance({ executionId: execution.id, stage: 'learning', knowledge: null });

  // 5 — render the reply text (LLM when wired; deterministic otherwise).
  const rendered = await renderReplyText(ctx, text, composed, inbound.id);

  const answer: ChatAnswer = {
    intent,
    mode: rendered.mode,
    headline: composed.headline,
    bullets: composed.bullets,
    note: composed.note,
    cards: composed.cards,
    citations: [
      ...composed.citations,
      ...(turnObservationId === null
        ? []
        : [
            {
              kind: 'observation' as const,
              id: turnObservationId,
              label: 'Your question, recorded as evidence',
              detail: 'The immutable observation this answer started from',
              href: '/evidence',
            },
          ]),
    ],
    executionId: execution.id,
  };

  // 6 — the reply (what Aurum actually said), linked as the execution's
  // product.
  const reply = await recordMessage(ctx, {
    conversationId,
    direction: 'outbound',
    actor: { kind: 'system', label: 'Aurum' },
    channel: 'web',
    payload: { text: rendered.text, starterId, answer } satisfies ChatTurnPayload,
    sentAt: now().toISOString(),
  });
  await recordExecutionLink(ctx, {
    messageId: reply.id,
    executionId: execution.id,
    role: 'produced',
  });

  return { conversationId, inbound, reply, executionId: execution.id, answer };
}
