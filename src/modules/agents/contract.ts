// ============================================================================
// agents — the ONLY public surface of the agents module
// (IMPLEMENTATION-STACK §2; cross-module imports of anything else are
// architecture violations detected by scripts/check-architecture.ts).
//
// W021 — Agent Gateway:
// "Provider-independent execution contract with permissions, async
//  execution, idempotency, retries, normalized results, evidence and
//  cost."
//
// ARCHITECTURE.md §16 (frozen): "Persistent agent definitions are
// separated from execution infrastructure: `agent definition → Agent
// Gateway → runtime/provider adapter → execution → normalized
// result/evidence/cost/outcome`. Agent providers/runtimes are
// replaceable. Execution is asynchronous, permission-scoped, retryable,
// traceable and idempotent where applicable."
//
//   Definitions (the persistent side of the §16 separation):
//   registerAgent — idempotently register one tenant-scoped agent
//      definition per slug: role, operating instructions, canonical
//      runtime provider, opaque runtime configuration and GRANTED
//      permission scopes. Claim-gated ('agents:administer') — minting
//      organizational actors with permissions is a management action.
//      Re-registering an existing slug reports created: false and the
//      first registration stands. The full agent lifecycle (PROPOSED →
//      APPROVAL → RECRUITED → ACTIVE → …, §15) is layered on by
//      W022–W024, not redefined here.
//   getAgent / listAgents / updateAgent — tenant-scoped reads with the
//      uniform not-found discipline, and the mutable management controls
//      (identity, instructions, runtime configuration, permissions,
//      enable/disable).
//
//   Execution (the provider-independent contract — W021's core):
//   submitAgentExecution — the ASYNC, IDEMPOTENT, PERMISSION-SCOPED,
//      POLICY-GATED submission: the requested permission scopes must be
//      covered by the agent's grant ('permission_not_granted' otherwise —
//      before anything is recorded), and the submission routes through
//      the W009 authority matrix (kind 'agent-execution') at the HIGHEST
//      §20 level the scopes imply: 'allowed' → queued; 'approval_
//      required' → awaiting_approval (a human decides through the
//      actions module; the pump resolves it); 'forbidden' → a terminal
//      'refused' record (evidence, §24). A caller-supplied idempotency
//      key replays the original execution — first write wins.
//   runAgentExecution — the explicit worker pump (lock 36): performs
//      exactly ONE bounded dispatch attempt per call through the
//      module-private runtime adapter + transport pair, serialized per
//      execution by an advisory transaction lock (the cognition pump
//      discipline). Resolves an approved gate, records append-only
//      attempt evidence (provider, provider task id, latency, usage,
//      deterministic integer-minor-unit cost, canonical result or
//      failure classification), and applies the retry policy: transient
//      failures re-queue while attempts remain; provider refusals and
//      unnormalizable results fail terminally.
//   cancelAgentExecution — the one-way live → cancelled transition with
//      a required reason (serialized with in-flight dispatches).
//   getAgentExecution / listAgentExecutions / listAgentExecutionAttempts
//      — the trace surface: executions filtered by agent / provider /
//      status / §25 correlation id, and each execution's append-only
//      attempt chain.
//   setAgentTransport / getAgentTransport — infrastructure wiring for
//      the provider-neutral delivery port. Transports that touch
//      provider SDKs/HTTP must live inside this module's adapters/
//      folder (IMPLEMENTATION-STACK §6 provider isolation); no transport
//      is wired by default, so dispatches fail explicitly with
//      `provider_unavailable` ("as provider availability permits").
//
// PROVIDER ISOLATION (lock 24): everything exported below is
// provider-neutral by construction. Runtimes appear only as the
// canonical `AgentRuntimeProvider` key; provider-native task bodies and
// result payloads are parsed inside `adapters/` and never leave. The
// only provider-minted values on this surface are OPAQUE strings
// (provider task ids, runtime agent references). Agent output is never
// authoritative truth (lock 10 mirrored) — executions and attempts are
// evidence consumers must validate.
//
// Tenancy (ADR-0001): every operation takes an explicit TenantContext
// and is tenant-scoped at the SQL layer; another tenant's agents,
// executions and attempt evidence are indistinguishable from missing
// ones — no existence leak.
//
// Dependency posture (WORK-ITEM-DEPENDENCY-GRAPH.md: W009 + W013 →
// W021; MODULE-DEPENDENCY-MAP.md: `actions + llm → agents`): this
// module imports ONLY the actions contract (the W009 authority gate —
// the matrix "applies uniformly", §20). The async/resumable pump
// discipline follows the cognition module's (W013) precedent without a
// contract dependency — cognition owns the intelligence loop, agents
// owns runtime execution; and the provider-gateway seam (transport +
// per-provider adapters, minor-unit cost, provider neutrality) follows
// the llm module's precedent, again without a contract dependency —
// agent runtimes are a distinct provider family (MODULE-DEPENDENCY-MAP
// provider boundaries), and W035 owns their registry/routing.
// ============================================================================

export {
  // Definitions
  getAgent,
  listAgents,
  registerAgent,
  updateAgent,
  // Execution
  cancelAgentExecution,
  getAgentExecution,
  listAgentExecutionAttempts,
  listAgentExecutions,
  runAgentExecution,
  submitAgentExecution,
  // Transport wiring
  getAgentTransport,
  setAgentTransport,
} from './service';

// Module-owned constants.
export { AGENTS_AUTHORITY_ADMINISTER_CLAIM, AGENT_ACTION_KIND } from './service';

export type {
  AgentAttemptErrorCode,
  AgentAttemptStatus,
  AgentDefinition,
  AgentExecution,
  AgentExecutionAttempt,
  AgentExecutionPolicySnapshot,
  AgentExecutionStatus,
  AgentPermissionScope,
  AgentRuntimeProvider,
  AgentStatus,
  AgentTaskResult,
  AgentUsage,
  AgentRuntimeTransport,
  AgentRuntimeTransportReceipt,
  AgentRuntimeTransportRequest,
  CancelAgentExecutionInput,
  GetAgentExecutionQuery,
  GetAgentQuery,
  ListAgentExecutionAttemptsQuery,
  ListAgentExecutionsQuery,
  ListAgentsQuery,
  RegisterAgentInput,
  RegisterAgentResult,
  RunAgentExecutionInput,
  SubmitAgentExecutionInput,
  UpdateAgentInput,
} from './types';

// Pure vocabulary and execution policy (no TenantContext needed).
export {
  AGENT_EXECUTION_STATUSES,
  AGENT_EXECUTION_TERMINAL_STATUSES,
  AGENT_PERMISSION_SCOPES,
  AGENT_RUNTIME_PROVIDERS,
  AGENT_STATUSES,
  AUTHORITY_LEVELS,
  authorityLevelForScope,
  authorityLevelForScopes,
  canAdministerAgents,
  classifyAttemptFailure,
  isAgentExecutionStatus,
  isAgentPermissionScope,
  isAgentRuntimeProvider,
  isAgentStatus,
  isAuthorityLevelWord,
  isTerminalExecutionStatus,
  missingPermissionScope,
  scopeForAuthorityLevel,
  statusAfterFailedAttempt,
} from './policy';

export type {
  AgentExecutionStatusWord,
  AgentPermissionScopeWord,
  AgentRuntimeProvider as AgentRuntimeProviderKey,
  AgentStatusWord,
  AttemptFailure,
  AuthorityLevelWord,
} from './policy';

export { AgentsError } from './errors';
export type { AgentsErrorCode } from './errors';

export {
  DEFAULT_LIST_LIMIT,
  DEFAULT_MAX_ATTEMPTS,
  MAX_CORRELATION_CHARS,
  MAX_DESCRIPTION_CHARS,
  MAX_DISPLAY_NAME_CHARS,
  MAX_IDEMPOTENCY_KEY_LENGTH,
  MAX_INSTRUCTIONS_CHARS,
  MAX_LIST_LIMIT,
  MAX_MAX_ATTEMPTS,
  MAX_PERMISSIONS,
  MAX_REASON_CHARS,
  MAX_ROLE_CHARS,
  MAX_RUNTIME_CONFIG_BYTES,
  MAX_SLUG_LENGTH,
  MAX_SUMMARY_CHARS,
  MAX_TASK_BYTES,
  isUuid,
} from './validation';

export type {
  ValidatedCancelInput,
  ValidatedListAgentsQuery,
  ValidatedListExecutionsQuery,
  ValidatedRegisterAgentInput,
  ValidatedRunInput,
  ValidatedSubmitInput,
  ValidatedUpdateAgentInput,
} from './validation';
