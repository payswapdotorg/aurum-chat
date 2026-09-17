// W048 — Provider Hot-Swap Verification: the provider-independent BUSINESS
// CODE fixture.
//
// This file is the object of the work item's core claim — "run the same
// capability against multiple AI providers/models and agent runtimes
// WITHOUT SEMANTIC MIGRATION OR BUSINESS CODE REWRITE" (WORK-ITEM-CATALOG
// W048; GOVERNANCE.md "Provider swap evidence"). It is written ONCE,
// against the provider-neutral module contracts only, and is executed by
// the verification suite against every provider/model/runtime
// configuration WITHOUT a single edit:
//
//   * it takes NO provider, model or runtime argument — the gateway, not
//     the business code, decides who serves the request (lock 28/30 for
//     the llm gateway, lock 24 for the agent gateway);
//   * it derives its domain outcomes from CANONICAL results only
//     (`LlmCanonicalResult`, `AgentTaskResult`) — provider-native wire
//     bodies never reach this layer by construction;
//   * its only coupling is the narrow gateway port it consumes
//     (`invokeLlm`, `submitAgentExecution`/`runAgentExecution`), injected
//     as plain functions so the fixture depends on the CONTRACT SEAM, not
//     on any module implementation (the boundary scan in the test suite
//     enforces this file's discipline structurally).
//
// Domain discipline (lock 10): LLM/agent output is bounded-reasoning
// EVIDENCE. The derived findings below are provider-neutral derived
// values; nothing here is authoritative truth merely because a model
// produced it.

import type { TenantContext } from '@/infra/tenant';
import type { InvokeLlmInput, LlmExecution } from '@/modules/llm/contract';
import type {
  AgentExecution,
  SubmitAgentExecutionInput,
} from '@/modules/agents/contract';

// ---------------------------------------------------------------------------
// The gateway ports the business code consumes (the contract seam)
// ---------------------------------------------------------------------------

/** The slice of the llm contract this capability needs. */
export interface LlmGatewayPort {
  invokeLlm(ctx: TenantContext, input: InvokeLlmInput): Promise<LlmExecution>;
}

/** The slice of the agents contract this capability needs. */
export interface AgentGatewayPort {
  submitAgentExecution(
    ctx: TenantContext,
    input: SubmitAgentExecutionInput,
  ): Promise<AgentExecution>;
  runAgentExecution(ctx: TenantContext, input: { executionId: string }): Promise<AgentExecution>;
}

// ---------------------------------------------------------------------------
// Capability 1 — conversation triage finding (text-generation)
// ---------------------------------------------------------------------------

export interface TriageRoutingPreference {
  /**
   * OPTIONAL operator routing instruction — tenant configuration passed
   * THROUGH to the gateway, never interpreted here. Its presence or
   * absence never changes the derived domain semantics.
   */
  pinnedAccountId?: string;
  pinnedModel?: string;
}

export interface TriageInput {
  conversationId: string;
  transcriptExcerpt: string;
  routing?: TriageRoutingPreference | null;
}

/**
 * The provider-neutral domain finding the capability derives. Note what is
 * NOT here: no provider, no model, no usage, no cost — those are gateway
 * evidence concerns (ARCHITECTURE.md §18 "authoritative business state
 * remains provider-neutral"). Two providers that answer the same canonical
 * request with the same canonical text MUST produce the exact same
 * finding — that equivalence is the hot-swap property under verification.
 */
export interface TriageFinding {
  conversationId: string;
  /** The first sentence of the canonical answer, capped (business rule). */
  headline: string;
  /** Business rule: answers containing 'urgent' escalate. */
  priority: 'high' | 'normal';
  /** Opaque link to the gateway evidence row (auditability, §24). */
  evidenceExecutionId: string;
  derivedFrom: 'text-generation';
}

const HEADLINE_MAX_CHARS = 120;

export function deriveTriageFinding(
  input: TriageInput,
  execution: LlmExecution,
): TriageFinding {
  if (execution.status !== 'completed' || execution.result === null) {
    throw new Error(
      `the triage capability requires a completed canonical result (execution '${execution.id}' is '${execution.status}')`,
    );
  }
  if (execution.result.kind !== 'text-generation') {
    throw new Error('the triage capability requires a text-generation result');
  }
  const text = execution.result.text.trim();
  const firstSentence = /^[^.!?]*[.!?]?/.exec(text)![0] ?? text;
  const headline =
    firstSentence.length > HEADLINE_MAX_CHARS
      ? `${firstSentence.slice(0, HEADLINE_MAX_CHARS - 1)}…`
      : firstSentence;
  return {
    conversationId: input.conversationId,
    headline,
    priority: /urgent/i.test(text) ? 'high' : 'normal',
    evidenceExecutionId: execution.id,
    derivedFrom: 'text-generation',
  };
}

/**
 * The business capability: triage one conversation excerpt into a finding.
 * The canonical request is assembled from business rules alone; the
 * provider/model serving it is the gateway's decision over TENANT state.
 */
export async function triageConversationFinding(
  gateway: LlmGatewayPort,
  ctx: TenantContext,
  input: TriageInput,
): Promise<TriageFinding> {
  const execution = await gateway.invokeLlm(ctx, {
    capability: 'text-generation',
    scope: 'analysis',
    dataClassification: 'internal',
    messages: [
      {
        role: 'system',
        content: 'Triage the conversation excerpt. Answer in one short sentence.',
      },
      {
        role: 'user',
        content: `Conversation ${input.conversationId}: ${input.transcriptExcerpt}`,
      },
    ],
    temperature: 0,
    maxOutputTokens: 512,
    pinnedAccountId: input.routing?.pinnedAccountId ?? null,
    pinnedModel: input.routing?.pinnedModel ?? null,
  });
  return deriveTriageFinding(input, execution);
}

// ---------------------------------------------------------------------------
// Capability 2 — conversation summary embedding (embedding)
// ---------------------------------------------------------------------------

export interface EmbeddingInput {
  conversationId: string;
  summaryText: string;
  routing?: TriageRoutingPreference | null;
}

/** Provider-neutral derived geometry of one canonical embedding. */
export interface EmbeddedSummary {
  conversationId: string;
  dimensions: number;
  /** Euclidean magnitude rounded to 4 decimals (deterministic derivation). */
  magnitudeRounded: number;
  firstComponent: number;
  evidenceExecutionId: string;
  derivedFrom: 'embedding';
}

export async function embedConversationSummary(
  gateway: LlmGatewayPort,
  ctx: TenantContext,
  input: EmbeddingInput,
): Promise<EmbeddedSummary> {
  const execution = await gateway.invokeLlm(ctx, {
    capability: 'embedding',
    scope: 'background',
    dataClassification: 'internal',
    embeddingInput: input.summaryText,
    pinnedAccountId: input.routing?.pinnedAccountId ?? null,
    pinnedModel: input.routing?.pinnedModel ?? null,
  });
  if (execution.status !== 'completed' || execution.result === null) {
    throw new Error(
      `the embedding capability requires a completed canonical result (execution '${execution.id}' is '${execution.status}')`,
    );
  }
  if (execution.result.kind !== 'embedding') {
    throw new Error('the embedding capability requires an embedding result');
  }
  const vector = execution.result.vector;
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return {
    conversationId: input.conversationId,
    dimensions: vector.length,
    magnitudeRounded: Math.round(magnitude * 10_000) / 10_000,
    firstComponent: vector[0] ?? 0,
    evidenceExecutionId: execution.id,
    derivedFrom: 'embedding',
  };
}

// ---------------------------------------------------------------------------
// Capability 3 — agent triage delegation (agent runtimes)
// ---------------------------------------------------------------------------

export interface AgentDelegationInput {
  /** Which agent definition executes — tenant configuration, not code. */
  agentId: string;
  conversationId: string;
  goal: string;
  correlationId?: string | null;
}

/**
 * The provider-neutral outcome of delegating triage to the agent
 * workforce. No runtime identity appears here (lock 24): the same
 * canonical task through different runtimes MUST derive the same outcome.
 */
export interface DelegationOutcome {
  conversationId: string;
  status: AgentExecution['status'];
  /** Business rule: the agent's structured verdict, when it reports one. */
  triaged: boolean;
  category: string | null;
  needsHuman: boolean | null;
  summary: string | null;
  attempts: number;
  evidenceExecutionId: string;
}

interface TriagedVerdict {
  triaged?: unknown;
  category?: unknown;
  needsHuman?: unknown;
}

export async function delegateTriageToAgent(
  gateway: AgentGatewayPort,
  ctx: TenantContext,
  input: AgentDelegationInput,
): Promise<DelegationOutcome> {
  const submitted = await gateway.submitAgentExecution(ctx, {
    agentId: input.agentId,
    task: {
      conversationId: input.conversationId,
      goal: input.goal,
      kind: 'conversation-triage',
    },
    requestedPermissions: ['observe', 'analyze'],
    correlationId: input.correlationId ?? null,
  });
  // The worker pump: exactly ONE bounded dispatch attempt per call (lock 36)
  // — the capability consumes the async contract, never a runtime.
  const execution = await gateway.runAgentExecution(ctx, { executionId: submitted.id });
  const verdict =
    execution.result !== null && typeof execution.result.output === 'object' &&
    execution.result.output !== null && !Array.isArray(execution.result.output)
      ? (execution.result.output as TriagedVerdict)
      : {};
  return {
    conversationId: input.conversationId,
    status: execution.status,
    triaged: verdict.triaged === true,
    category: typeof verdict.category === 'string' ? verdict.category : null,
    needsHuman:
      verdict.needsHuman === true || verdict.needsHuman === false
        ? (verdict.needsHuman as boolean)
        : null,
    summary: execution.result?.summary ?? null,
    attempts: execution.attemptsCount,
    evidenceExecutionId: execution.id,
  };
}
