// Public domain types of the agents module (W021 — Agent Gateway).
//
// W021 owns the provider-independent EXECUTION contract of the agent
// workforce (ARCHITECTURE.md §16, frozen): "Persistent agent definitions
// are separated from execution infrastructure: `agent definition → Agent
// Gateway → runtime/provider adapter → execution → normalized
// result/evidence/cost/outcome`. Agent providers/runtimes are replaceable.
// Execution is asynchronous, permission-scoped, retryable, traceable and
// idempotent where applicable."
//
// Everything in this file is provider-neutral BY CONSTRUCTION (lock 24:
// "Agent providers/runtimes are hidden behind the Agent Gateway";
// MODULE-DEPENDENCY-MAP provider boundaries: "`agents` owns agent runtime
// providers ... no domain module may depend on provider-specific ...
// runtime state"). Runtimes appear only as the canonical
// `AgentRuntimeProvider` key owned by this module's vocabulary;
// provider-native task bodies and result payloads exist ONLY inside
// `adapters/` and never cross the module boundary in their raw shape. The
// only provider-minted values that cross are OPAQUE strings (provider task
// ids, runtime agent references).
//
// The three halves of the W021 acceptance, kept distinct by the types:
//   * DEFINITIONS — `AgentDefinition` is the persistent, tenant-scoped
//     agent record (role, instructions, runtime provider, opaque runtime
//     configuration, granted permission scopes). Definitions are
//     management configuration (mutable controls, like the llm module's
//     accounts) — the full agent lifecycle (PROPOSED → APPROVAL →
//     RECRUITED → ACTIVE → …, ARCHITECTURE.md §15) is built on top by
//     W022–W024, not redefined here.
//   * EXECUTIONS — `AgentExecution` is the asynchronous unit of work: an
//     explicit, resumable record (lock 36) that carries its W009 authority
//     decision, its permission scopes, §25 correlation/causation
//     identities, its retry policy and its accumulated cost, and moves
//     through a one-way lifecycle (awaiting_approval / queued →
//     succeeded / failed / refused / cancelled).
//   * EVIDENCE — `AgentExecutionAttempt` is the append-only evidence of
//     ONE provider dispatch: provider, provider task id, latency, usage,
//     deterministic integer-minor-unit cost and the normalized result (or
//     the failure classification). Attempts are evidence of how the agent
//     workforce actually executed (§24) — never authoritative business
//     truth (lock 10 mirrored); consumers treat results as agent output
//     pending domain validation.
//
// Cost follows the house convention (IMPLEMENTATION-STACK §8): integer
// minor units + ISO currency code, computed deterministically from the
// provider-reported usage by the adapter that understands the provider's
// pricing (module-internal; W035 centralizes runtime registry/pricing).

// ---------------------------------------------------------------------------
// Vocabularies mirrored by the migrations' CHECK constraints
// ---------------------------------------------------------------------------

/**
 * Canonical agent-runtime provider vocabulary (owned by this module — the
 * agents counterpart of the sources module's SourceProvider keys).
 * Mirrored by the `provider` CHECK in migrations/001 and the adapter
 * registry. Swapping runtimes never touches a domain contract (lock 24).
 */
export type AgentRuntimeProvider =
  | 'openai-assistants'
  | 'langgraph'
  | 'crewai'
  | 'autogen'
  | 'semantic-kernel';

/** Lifecycle states of an agent definition (management configuration). */
export type AgentStatus = 'active' | 'disabled';

/**
 * The lifecycle states of an agent execution. `awaiting_approval` and
 * `queued` are live (resumable — lock 36); the rest are terminal:
 *  * `awaiting_approval` — the W009 authority matrix gated the submission
 *    behind a human decision (the linked action request is pending);
 *  * `queued`            — admitted; waiting for a worker dispatch;
 *  * `succeeded`         — an attempt completed with a normalized result;
 *  * `failed`            — retries exhausted, or a permanent failure;
 *  * `refused`           — the authority matrix forbade it, or a human
 *    rejected the gated submission (recorded as evidence);
 *  * `cancelled`         — a caller cancelled it before completion.
 */
export type AgentExecutionStatus =
  | 'awaiting_approval'
  | 'queued'
  | 'succeeded'
  | 'failed'
  | 'refused'
  | 'cancelled';

/** The outcome classification of one dispatch attempt. */
export type AgentAttemptStatus = 'completed' | 'failed';

/**
 * The canonical failure codes recorded on failed attempts (and, when
 * terminal, on the execution). The retry policy maps each to a
 * retryability decision (policy.ts):
 *  * `dispatch_failed`  — transient transport/runtime failure → retryable;
 *  * `dispatch_rejected`— the runtime refused the task (auth, quota,
 *    content policy …) → permanent;
 *  * `result_invalid`   — the runtime returned a payload the adapter
 *    cannot normalize into the canonical contract → permanent (loud
 *    failure, never a silent substitute value).
 */
export type AgentAttemptErrorCode =
  | 'dispatch_failed'
  | 'dispatch_rejected'
  | 'result_invalid';

// ---------------------------------------------------------------------------
// Permissions (permission-scoped execution — §16)
// ---------------------------------------------------------------------------

/**
 * The canonical permission scopes an agent execution may operate at — the
 * lowercase mirrors of the six §20 authority levels (the actions module's
 * vocabulary, applied uniformly to the agent workforce). An agent
 * definition GRANTS scopes; every execution REQUESTS scopes; the gateway
 * admits only requests fully covered by the grant (policy.ts, tested).
 *
 * The scope→level mapping also drives the W009 gate: an execution is
 * authorized at the HIGHEST authority level its requested scopes imply,
 * so the tenant's authority matrix governs agent execution exactly as it
 * governs every other consequential action (§20 "applies uniformly").
 */
export type AgentPermissionScope =
  | 'observe'
  | 'analyze'
  | 'recommend'
  | 'ask'
  | 'propose'
  | 'execute';

// ---------------------------------------------------------------------------
// Agent definitions (the persistent side of the §16 separation)
// ---------------------------------------------------------------------------

/**
 * A tenant-scoped persistent agent definition: WHAT the agent is and MAY
 * do, independent of the infrastructure that runs it (§16). The full
 * organizational actor (objectives, budget, owner, review schedule,
 * lifecycle approvals — §15) is layered on by W022–W024; this record
 * carries what the gateway's execution contract needs.
 *
 *  * `provider` — the canonical runtime provider key; the ONLY place a
 *    runtime identity appears on the public surface.
 *  * `runtimeConfig` — OPAQUE, adapter-consumed configuration (model
 *    binding, provider-side agent/thread ids, tool wiring …). Plain JSON;
 *    provider-shaped VALUES are allowed, provider TYPES are not (the same
 *    discipline the actions module applies to payloads). Credential
 *    VALUES never belong here — only opaque secret-store references
 *    (GOVERNANCE mandatory invariant).
 *  * `permissions` — the granted scopes (closed vocabulary, deduplicated,
 *    canonically ordered).
 */
export interface AgentDefinition {
  id: string;
  tenantId: string;
  /** Unique per tenant. */
  slug: string;
  displayName: string | null;
  role: string;
  description: string | null;
  provider: AgentRuntimeProvider;
  /** The agent's operating contract — what it is instructed to do. */
  instructions: string;
  /** Opaque, adapter-consumed runtime configuration (plain JSON). */
  runtimeConfig: unknown;
  permissions: AgentPermissionScope[];
  status: AgentStatus;
  createdBy: string;
  /** ISO 8601 — service clock. */
  createdAt: string;
  /** ISO 8601 — service clock; moves on configuration changes only. */
  updatedAt: string;
}

export interface RegisterAgentInput {
  slug: string;
  displayName?: string | null;
  role: string;
  description?: string | null;
  provider: AgentRuntimeProvider;
  instructions: string;
  runtimeConfig?: unknown;
  /** Granted permission scopes (1..6, closed vocabulary). */
  permissions: AgentPermissionScope[];
}

export interface RegisterAgentResult {
  agent: AgentDefinition;
  /** false when an agent with this slug already existed (first write wins). */
  created: boolean;
}

export interface UpdateAgentInput {
  agentId: string;
  displayName?: string | null;
  role?: string;
  description?: string | null;
  instructions?: string;
  runtimeConfig?: unknown;
  permissions?: AgentPermissionScope[];
  status?: AgentStatus;
}

export interface ListAgentsQuery {
  provider?: AgentRuntimeProvider;
  status?: AgentStatus;
  /** 1..500, default 50. */
  limit?: number;
}

export interface GetAgentQuery {
  agentId: string;
}

// ---------------------------------------------------------------------------
// Agent executions (the asynchronous unit of work)
// ---------------------------------------------------------------------------

/** The frozen W009 decision that admitted (or refused) the submission. */
export interface AgentExecutionPolicySnapshot {
  actionRequestId: string;
  /** 'allowed' = policy auto-approval; 'approval_required' = a human decided the gated request; 'forbidden' = policy refusal. */
  outcome: 'allowed' | 'approval_required' | 'forbidden';
  resolvedVia: 'kind' | 'tenant-default' | 'built-in';
}

/** The canonical, provider-neutral result of a succeeded execution. */
export interface AgentTaskResult {
  /** The agent's output — any plain JSON value. */
  output: unknown;
  /** One-line human-readable summary, when the runtime reports one. */
  summary: string | null;
}

/** Provider-reported usage of one attempt, normalized (null = not reported). */
export interface AgentUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  /** Other billable units the runtime counts (steps, tool calls, runs …). */
  operations: number | null;
}

/**
 * One agent execution — the explicit, asynchronous, resumable record of
 * dispatching a task to an agent's runtime (§16; lock 36). The submission
 * fields (agent, task, scopes, gate, identities, retry policy) are
 * immutable history the moment they are recorded; only the LIVE state
 * (status, attempts, result, failure, cost, completedAt) ever moves, and
 * only forward (PostgreSQL triggers enforce both — migrations/002).
 */
export interface AgentExecution {
  id: string;
  tenantId: string;
  agentId: string;
  /** Denormalized at submission (the definition's provider at that moment). */
  provider: AgentRuntimeProvider;
  /** The task to run — any plain JSON value. */
  task: unknown;
  /** The scopes this execution requested (all within the agent's grant). */
  requestedPermissions: AgentPermissionScope[];
  /** The §20 level the W009 gate evaluated (highest requested scope). */
  authorityLevel:
    | 'OBSERVE'
    | 'ANALYZE'
    | 'RECOMMEND'
    | 'ASK'
    | 'PROPOSE'
    | 'EXECUTE';
  idempotencyKey: string | null;
  /** §25 correlation identity (opaque; groups related executions). */
  correlationId: string | null;
  /** §25 causation identity (opaque; what caused this execution). */
  causationId: string | null;
  status: AgentExecutionStatus;
  /** The W009 decision frozen at submission. */
  policy: AgentExecutionPolicySnapshot;
  /** 1..5; the retry ceiling for transient dispatch failures. */
  maxAttempts: number;
  /** Dispatch attempts performed so far (evidence rows exist for each). */
  attemptsCount: number;
  /** Canonical result when succeeded; null otherwise. */
  result: AgentTaskResult | null;
  /** Canonical failure code when failed/refused/cancelled; null otherwise. */
  errorCode: string | null;
  errorDetail: string | null;
  /** Sum of attempt costs, integer minor units. */
  costMinor: number;
  costCurrency: 'USD';
  submittedBy: string;
  /** ISO 8601 — service clock. */
  submittedAt: string;
  /** ISO 8601 — when the terminal state landed; null while live. */
  completedAt: string | null;
  updatedAt: string;
}

/** Input shape of `submitAgentExecution` — the async submission. */
export interface SubmitAgentExecutionInput {
  agentId: string;
  /** The task — any non-null plain JSON value (≤ 1 MiB). */
  task: unknown;
  /** 1..6 permission scopes the execution operates at. */
  requestedPermissions: AgentPermissionScope[];
  /** 1..5, default 3. */
  maxAttempts?: number;
  /** §25 correlation identity. */
  correlationId?: string | null;
  /** §25 causation identity. */
  causationId?: string | null;
  /** Emitter-supplied dedupe key; a recorded key replays the original execution. */
  idempotencyKey?: string | null;
}

/** Input shape of `runAgentExecution` — the worker pump (ONE attempt per call). */
export interface RunAgentExecutionInput {
  executionId: string;
}

/**
 * One dispatch attempt — the append-only EVIDENCE of one provider
 * dispatch performed by the worker pump (§16 "execution → normalized
 * result/evidence/cost/outcome"). What was dispatched, to which runtime,
 * with which provider task id, how long it took, what it cost and what
 * it normalized into is history the moment it happens (storage-level
 * triggers reject UPDATE/DELETE — migrations/003).
 */
export interface AgentExecutionAttempt {
  id: string;
  tenantId: string;
  executionId: string;
  /** 1..maxAttempts; unique per execution (also the double-dispatch guard). */
  attemptNumber: number;
  provider: AgentRuntimeProvider;
  status: AgentAttemptStatus;
  /** The deterministic retry classification (true only for transient failures). */
  retryable: boolean;
  errorCode: AgentAttemptErrorCode | null;
  errorDetail: string | null;
  /** The canonical result when completed; null when failed. */
  result: AgentTaskResult | null;
  usage: AgentUsage;
  /** This attempt's deterministic cost, integer minor units. */
  costMinor: number;
  costCurrency: 'USD';
  providerTaskId: string | null;
  /** Measured dispatch duration (service clock). */
  latencyMs: number;
  /** ISO 8601 — the attempt's bounded time box. */
  dispatchedAt: string;
  finishedAt: string;
  dispatchedBy: string;
}

/** Input shape of `cancelAgentExecution` (live executions only). */
export interface CancelAgentExecutionInput {
  executionId: string;
  /** Required reason (1..512 chars) — recorded on the terminal state. */
  reason: string;
}

export interface GetAgentExecutionQuery {
  executionId: string;
}

export interface ListAgentExecutionsQuery {
  agentId?: string;
  provider?: AgentRuntimeProvider;
  status?: AgentExecutionStatus;
  correlationId?: string;
  /** 1..500, default 50. */
  limit?: number;
}

export interface ListAgentExecutionAttemptsQuery {
  executionId: string;
}

// ---------------------------------------------------------------------------
// The runtime transport port (provider-neutral delivery; implementations
// are module-internal — provider SDKs may only live inside src/modules/agents/)
// ---------------------------------------------------------------------------

/**
 * The provider-neutral request handed to the transport. `body` is the
 * provider-native task JSON the runtime's ADAPTER built — OPAQUE to the
 * transport and to everything outside the module boundary (lock 24).
 * `runtimeAgentRef` is the adapter-resolved, provider-side agent reference
 * (an OpenAI assistant id, a LangGraph assistant id, …) — opaque string.
 */
export interface AgentRuntimeTransportRequest {
  provider: AgentRuntimeProvider;
  /** The Aurum agent definition id (traceability on the wire). */
  agentId: string;
  /** Adapter-resolved provider-side agent reference (opaque string). */
  runtimeAgentRef: string;
  body: unknown;
}

/**
 * Provider-neutral outcome of one runtime dispatch:
 *  * `delivered` — the runtime ACCEPTED the task and returned a payload
 *    (the adapter parses it into a canonical result);
 *  * `rejected`  — the runtime refused it (permanent: auth, quota,
 *    content policy …);
 *  * `failed`    — transport error (transient; the retry policy applies).
 */
export interface AgentRuntimeTransportReceipt {
  status: 'delivered' | 'rejected' | 'failed';
  /** The runtime's native response payload when `delivered`; opaque to the transport contract. */
  payload: unknown;
  /** The runtime's own task/run id (opaque string), when it returns one. */
  providerTaskId: string | null;
  detail: string | null;
}

/**
 * The delivery port real transports implement. Transports that touch
 * provider SDKs/HTTP must live inside `src/modules/agents/adapters/`
 * (IMPLEMENTATION-STACK §6 provider isolation); they are wired at process
 * start via `setAgentTransport`. No transport is wired by default —
 * dispatches then fail explicitly with `provider_unavailable` (the
 * llm/channels/sources "as provider availability permits" discipline).
 */
export interface AgentRuntimeTransport {
  send(request: AgentRuntimeTransportRequest): Promise<AgentRuntimeTransportReceipt>;
}
