// ============================================================================
// llm — the ONLY public surface of the llm module
// (IMPLEMENTATION-STACK §2; cross-module imports of anything else are
// architecture violations detected by scripts/check-architecture.ts).
//
// W034 — LLM Gateway and BYOA:
// "Provider/model registry, tenant-owned AI provider accounts, routing,
//  availability, performance, cost, policy and hot-swap verification."
//
//   Registry (locks 28/30 — code-owned, provider-neutral):
//   listLlmProviders / listLlmModels / findLlmModel — the canonical
//      provider/model catalog with capabilities, context windows, output
//      caps and list prices (integer minor units per million tokens).
//      The registry is platform reference data that versions with the
//      adapter set (the channels module's CHANNEL_PROVIDERS discipline);
//      it confers NO routing privilege — preference belongs to the tenant.
//
//   Tenant-owned accounts (BYOA — lock 29, ARCHITECTURE.md §18):
//   registerAiProviderAccount — idempotently register one tenant-owned
//      provider account: opaque credential reference, scopes, capability
//      permissions, data-policy ceiling, routing priority and monthly
//      budget. Claim-gated ('llm:administer') — attaching external AI
//      endpoints to a tenant is a management action.
//   getAiProviderAccount / listAiProviderAccounts — tenant-scoped reads
//      (uniform not-found for foreign ids).
//   updateAiProviderAccount — upsert the mutable management controls
//      (credential rotation, scopes, capabilities, data policy, priority,
//      budget, enable/disable).
//
//   Invocation (the canonical gateway path — lock 28):
//   invokeLlm — execute one canonical capability request through the
//      tenant's routed (account, model): W009 authority gate first (kind
//      'llm-invocation', level ANALYZE — approved proceeds, forbidden
//      fails, approval-required waits for a human decision and replays the
//      same request on retry with the same idempotencyKey), then the
//      deterministic eligibility routing (scope / capability / data
//      policy / budget / model output limit / availability), then ONE
//      provider interaction through the module-private adapter + transport
//      pair, recorded as append-only evidence with provider/model
//      metadata, usage, integer-minor-unit cost and measured latency.
//      Automatic failover walks the ordered candidate list when a
//      provider fails; every attempt is evidence. An optional explicit
//      pin (pinnedAccountId [+ pinnedModel]) is an operator instruction
//      that bypasses only the availability heuristic.
//   setLlmTransport / getLlmTransport — infrastructure wiring for the
//      provider-neutral transport port. Transports that touch provider
//      SDKs/HTTP must live inside this module's adapters/ folder
//      (IMPLEMENTATION-STACK §6 provider isolation); no transport is
//      wired by default, so invocations fail explicitly with
//      `provider_unavailable` ("as provider availability permits" — the
//      channels module's discipline).
//
//   Availability, performance, cost (reads):
//   setAiAvailability / getAiAvailability — manual availability overrides
//      (claim-gated) and the current per-(account, model) states; the
//      execution path records automatic transitions (failure cooldowns
//      and recoveries) as append-only events.
//   getLlmExecution / listLlmExecutions — the append-only evidence feed.
//   getLlmUsageSummary — per (provider, model, capability) aggregates:
//      counts, failures, tokens, cost and latency (performance/cost).
//   getAiProviderAccountSpend — budget posture for the current UTC month.
//
//   Hot-swap verification (GOVERNANCE "provider swap evidence"; W048 seed):
//   verifyProviderHotSwap / getHotSwapVerification — run the SAME
//      canonical request (SHA-256 digest) through two different pinned
//      (provider, model) targets with no business-code or contract
//      change, and record a DETERMINISTIC structural comparison:
//      'equivalent' (identical normalized output), 'completed-divergent'
//      (both completed, outputs differ textually — the swap still proved;
//      semantic judgment stays with the caller) or 'failed'.
//
// PROVIDER ISOLATION (locks 28/30): everything exported below is
// provider-neutral by construction. Providers appear only as the registry's
// canonical `LlmProvider` key; provider-native wire bodies and response
// payloads are parsed inside `adapters/` and never leave. The only
// provider-minted values on this surface are OPAQUE strings (model ids,
// provider execution ids). LLM output is never authoritative (lock 10) —
// executions are bounded-reasoning evidence.
//
// Tenancy (ADR-0001): every operation takes an explicit TenantContext and
// is tenant-scoped at the SQL layer; another tenant's accounts,
// executions, availability and verifications are indistinguishable from
// missing ones — no existence leak.
// ============================================================================

export {
  // Accounts (BYOA)
  getAiProviderAccount,
  listAiProviderAccounts,
  registerAiProviderAccount,
  updateAiProviderAccount,
  // Invocation + transport
  getLlmTransport,
  invokeLlm,
  setLlmTransport,
  // Availability
  getAiAvailability,
  setAiAvailability,
  // Evidence, cost, performance
  getAiProviderAccountSpend,
  getLlmExecution,
  getLlmUsageSummary,
  listLlmExecutions,
  // Hot-swap verification
  getHotSwapVerification,
  verifyProviderHotSwap,
} from './service';

export type { VerifyProviderHotSwapResult } from './service';

// Registry (pure, code-owned reference data — no TenantContext needed).
export { findLlmModel, listLlmModels, listLlmProviders } from './registry';

// Module-owned constants.
export {
  AVAILABILITY_COOLDOWN_MS,
  LLM_ACTION_KIND,
  LLM_AUTHORITY_ADMINISTER,
} from './service';
export {
  LLM_CAPABILITIES,
  LLM_PROVIDERS,
  isLlmCapability,
  isLlmProvider,
} from './registry';
export {
  DATA_CLASSIFICATIONS,
  LLM_SCOPES,
} from './types';

export { LlmError } from './errors';
export type { LlmErrorCode } from './errors';

export {
  DEFAULT_LIST_LIMIT,
  IDEMPOTENCY_KEY_PATTERN,
  MAX_BUDGET_MINOR,
  MAX_CREDENTIAL_REF_LENGTH,
  MAX_EMBEDDING_DIMENSIONS,
  MAX_EMBEDDING_INPUT_LENGTH,
  MAX_LABEL_LENGTH,
  MAX_LIST_LIMIT,
  MAX_MESSAGES,
  MAX_MESSAGE_CONTENT_LENGTH,
  MAX_MODEL_ID_LENGTH,
  MAX_OUTPUT_TOKENS,
  MAX_PRIORITY,
  MAX_REASON_LENGTH,
  MAX_REQUEST_BYTES,
  MAX_RESULT_TEXT_LENGTH,
  MAX_TEMPERATURE,
  MIN_PRIORITY,
  isAiProviderAccountStatus,
  isDataClassification,
  isLlmAvailabilityState,
  isLlmExecutionPurpose,
  isLlmExecutionStatus,
  isLlmScope,
  isUuid,
} from './validation';

export type {
  ValidatedInvokeInput,
  ValidatedRegisterAccountInput,
  ValidatedUpdateAccountInput,
  ValidatedVerifyHotSwapInput,
} from './validation';

export type {
  AiProviderAccount,
  AiProviderAccountSpend,
  AiProviderAccountStatus,
  CanonicalLlmMessage,
  CanonicalLlmMessageRole,
  DataClassification,
  HotSwapTarget,
  InvokeLlmInput,
  LlmAvailability,
  LlmAvailabilitySource,
  LlmAvailabilityState,
  LlmCanonicalResult,
  LlmCapability,
  LlmExecution,
  LlmExecutionPurpose,
  LlmExecutionStatus,
  LlmHotSwapOutcome,
  LlmHotSwapVerification,
  LlmModelDescriptor,
  LlmProvider,
  LlmRoutingCandidateSnapshot,
  LlmRoutingRejectionReason,
  LlmRoutingSnapshot,
  LlmScope,
  LlmExecutionPolicySnapshot,
  LlmTransport,
  LlmTransportReceipt,
  LlmTransportRequest,
  LlmUsageSummaryRow,
  LlmWireRequestKind,
  RegisterAiProviderAccountInput,
  RegisterAiProviderAccountResult,
  ResolvedHotSwapTarget,
  SetAiAvailabilityInput,
  UpdateAiProviderAccountInput,
  VerifyProviderHotSwapInput,
} from './types';
