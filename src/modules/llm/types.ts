// Public domain types of the llm module (W034 — LLM Gateway and BYOA).
//
// Everything in this file is provider-neutral BY CONSTRUCTION (lock 28:
// "AI/LLM providers are accessed only through the LLM Gateway"; lock 30:
// "no provider/model is architecturally privileged"; MODULE-DEPENDENCY-MAP:
// "llm owns AI/LLM providers ... no domain module may depend on
// provider-specific ... model objects"). Providers appear only as the
// neutral `LlmProvider` key owned by this module's registry; provider-native
// request bodies and response payloads exist ONLY inside `adapters/` and
// never leave this module in their raw shape. The only provider-minted
// values that cross the boundary are OPAQUE strings (model ids, provider
// execution ids) — exactly the discipline the channels module applies to
// provider message ids.
//
// ARCHITECTURE.md §18 names the DISTINCT concerns this module must keep
// distinct — capability, eligibility, authorization, policy, availability,
// performance, preference, cost and latency — and the types below carry that
// separation:
//   * capability        — what the caller asks the gateway for
//     (`LlmCapability`, on the request);
//   * eligibility        — which (account, model) pairs may serve it
//     (`LlmRoutingCandidateSnapshot.reason` carries the machine reasons);
//   * authorization      — the W009 authority-matrix decision
//     (`LlmExecutionPolicySnapshot` on every execution);
//   * policy (data)      — per-account data classification ceiling
//     (`AiProviderAccount.maxDataClassification`);
//   * availability      — per (account, model) outage/cooldown state
//     (`LlmAvailability`, append-only events);
//   * performance        — recorded latency + aggregate summaries
//     (`LlmExecution.latencyMs`, `LlmUsageSummaryRow`);
//   * preference         — tenant routing preferences on the account
//     (`AiProviderAccount.priority` — no registry-level privilege, lock 30);
//   * cost               — integer minor units + ISO currency
//     (`LlmExecution.costMinor/costCurrency`, `AiProviderAccountSpend`);
//   * latency            — measured per execution (`LlmExecution.latencyMs`).
//
// LLM output is NEVER authoritative (lock 10): executions are evidence of
// bounded reasoning (ARCHITECTURE.md §19), recorded append-only with their
// provider/model metadata for auditability (§18) while authoritative
// business state stays provider-neutral.

import type { LlmCapability, LlmModelDescriptor, LlmProvider } from './registry';

export type { LlmCapability, LlmModelDescriptor, LlmProvider };

// ---------------------------------------------------------------------------
// Vocabularies mirrored by the migrations' CHECK constraints
// ---------------------------------------------------------------------------

/** What an AI provider account may be used FOR (which Aurum surfaces). */
export const LLM_SCOPES = ['cognition', 'conversation', 'analysis', 'background'] as const;
export type LlmScope = (typeof LLM_SCOPES)[number];

/** Sensitivity classifications of data handed to a provider (ordered: public < internal < restricted). */
export const DATA_CLASSIFICATIONS = ['public', 'internal', 'restricted'] as const;
export type DataClassification = (typeof DATA_CLASSIFICATIONS)[number];

export type AiProviderAccountStatus = 'active' | 'disabled';
export type LlmAvailabilityState = 'available' | 'unavailable';
export type LlmAvailabilitySource = 'execution' | 'manual';
export type LlmExecutionStatus = 'completed' | 'failed';
export type LlmExecutionPurpose = 'invocation' | 'hot-swap-verification';
export type LlmHotSwapOutcome = 'equivalent' | 'completed-divergent' | 'failed';

// ---------------------------------------------------------------------------
// Canonical requests and results (provider-neutral)
// ---------------------------------------------------------------------------

export type CanonicalLlmMessageRole = 'system' | 'user' | 'assistant';

/** One canonical chat turn (plain text only — multimodality is a future capability). */
export interface CanonicalLlmMessage {
  role: CanonicalLlmMessageRole;
  content: string;
}

/** The canonical result of one capability execution — what the caller receives. */
export type LlmCanonicalResult =
  | { kind: 'text-generation'; text: string }
  | { kind: 'embedding'; vector: number[] };

// ---------------------------------------------------------------------------
// Tenant-owned AI provider accounts (BYOA — lock 29)
// ---------------------------------------------------------------------------

/**
 * A tenant-scoped AI provider account the gateway may route to
 * (ARCHITECTURE.md §18: "Tenants may connect their own AI providers/
 * accounts through AIProviderAccount records, with scopes, capability
 * permissions, budgets, routing preferences and data policies").
 *
 *  * `credentialRef` — OPAQUE reference into the secret store holding the
 *    provider credentials; the credential VALUE never reaches any domain
 *    table (IMPLEMENTATION-STACK §8; GOVERNANCE mandatory invariant).
 *  * `scopes` — which Aurum surfaces may use the account (eligibility).
 *  * `capabilities` — which canonical capabilities the account permits
 *    (must be a subset of the model's capabilities — the account is the
 *    tenant's own permission to use that capability on their account).
 *  * `maxDataClassification` — the account's DATA POLICY ceiling: requests
 *    carrying a higher classification never route here.
 *  * `priority` — routing preference: among eligible (account, model)
 *    candidates, lower priority is preferred (deterministic tiebreak:
 *    creation time, then id). Registry position NEVER participates
 *    (lock 30 — no architecturally privileged provider/model).
 *  * `budgetMinor`/`budgetCurrency` — monthly (UTC calendar month) spend cap
 *    in integer minor units on COMPLETED executions; null = no budget.
 *    A budget may be overshot by the tail of the execution that crosses it
 *    (metering semantics — spend is accounted from recorded evidence).
 */
export interface AiProviderAccount {
  id: string;
  tenantId: string;
  provider: LlmProvider;
  /** Tenant-chosen unique label for this (tenant, provider). */
  label: string;
  credentialRef: string;
  status: AiProviderAccountStatus;
  scopes: LlmScope[];
  capabilities: LlmCapability[];
  maxDataClassification: DataClassification;
  priority: number;
  budgetMinor: number | null;
  budgetCurrency: 'USD';
  createdBy: string;
  /** ISO 8601 — service clock. */
  createdAt: string;
  /** ISO 8601 — service clock; moves on config changes only. */
  updatedAt: string;
}

export interface RegisterAiProviderAccountInput {
  provider: LlmProvider;
  label: string;
  /** Opaque secret-store reference (never the credential value). */
  credentialRef: string;
  scopes: LlmScope[];
  capabilities: LlmCapability[];
  maxDataClassification: DataClassification;
  priority: number;
  budgetMinor?: number | null;
}

export interface RegisterAiProviderAccountResult {
  account: AiProviderAccount;
  /** false when an account for this (provider, label) already existed. */
  created: boolean;
}

export interface UpdateAiProviderAccountInput {
  accountId: string;
  credentialRef?: string;
  scopes?: LlmScope[];
  capabilities?: LlmCapability[];
  maxDataClassification?: DataClassification;
  priority?: number;
  budgetMinor?: number | null;
  status?: AiProviderAccountStatus;
}

export interface ListAiProviderAccountsQuery {
  provider?: LlmProvider;
  status?: AiProviderAccountStatus;
  /** 1..500, default 50. */
  limit?: number;
}

// ---------------------------------------------------------------------------
// Availability (per (account, model) — append-only observation evidence)
// ---------------------------------------------------------------------------

/**
 * The current availability of one (account, model) pair. `state` is the
 * EFFECTIVE state (an `unavailable` event whose expiry has passed reads as
 * `available` again); `reason`, `source`, `expiresAt` and `observedAt`
 * describe the latest event that produced it. Transitions are recorded as
 * append-only events — nothing rewrites availability history.
 */
export interface LlmAvailability {
  accountId: string;
  provider: LlmProvider;
  model: string;
  state: LlmAvailabilityState;
  reason: string | null;
  source: LlmAvailabilitySource;
  /** When the unavailable state lapses; null = indefinite (or n/a for available). */
  expiresAt: string | null;
  /** ISO 8601 — when the deciding event was observed. */
  observedAt: string;
}

export interface SetAiAvailabilityInput {
  accountId: string;
  model: string;
  state: LlmAvailabilityState;
  reason?: string | null;
  /** Strict ISO 8601; only meaningful (and allowed) for `unavailable`. */
  expiresAt?: string | null;
}

export interface GetAiAvailabilityQuery {
  accountId?: string | null;
}

// ---------------------------------------------------------------------------
// Executions (append-only evidence with provider/model metadata)
// ---------------------------------------------------------------------------

/** Why one (account, model) candidate was or was not routable. */
export type LlmRoutingRejectionReason =
  | 'account_disabled'
  | 'scope_not_permitted'
  | 'capability_not_permitted'
  | 'data_classification_exceeds_account_policy'
  | 'budget_exhausted'
  | 'capability_not_supported_by_model'
  | 'model_output_limit'
  | 'unavailable'
  | 'not_pinned_target';

export interface LlmRoutingCandidateSnapshot {
  accountId: string;
  provider: LlmProvider;
  model: string;
  eligible: boolean;
  /** null when eligible; the machine reason otherwise. */
  reason: LlmRoutingRejectionReason | null;
}

/** The deterministic routing decision frozen onto an execution (§24 auditability). */
export interface LlmRoutingSnapshot {
  /** true when the caller pinned the account (and possibly the model). */
  pinned: boolean;
  candidates: LlmRoutingCandidateSnapshot[];
  chosen: { accountId: string; provider: LlmProvider; model: string } | null;
}

/** The W009 authority-matrix decision that admitted the execution. */
export interface LlmExecutionPolicySnapshot {
  actionRequestId: string;
  /** The matrix outcome frozen on the action request at gate time ('allowed' = policy auto-approval; 'approval_required' = a human approved the gated request). */
  outcome: 'allowed' | 'approval_required' | 'forbidden';
  resolvedVia: 'kind' | 'tenant-default' | 'built-in';
}

/**
 * One gateway execution — the append-only evidence of one provider
 * interaction. Completed executions retain their provider/model metadata,
 * usage, deterministic cost and measured latency (§18); the result is
 * canonical and provider-neutral. Failed executions are evidence too
 * (including the routing/failure reason). Nothing here is authoritative
 * business truth (lock 10) — consumers treat it as bounded-reasoning
 * evidence.
 */
export interface LlmExecution {
  id: string;
  tenantId: string;
  purpose: LlmExecutionPurpose;
  capability: LlmCapability;
  provider: LlmProvider;
  model: string;
  accountId: string;
  status: LlmExecutionStatus;
  /** Canonical llm error code when failed; null when completed. */
  errorCode: string | null;
  errorDetail: string | null;
  /** Canonical result when completed; null when failed. */
  result: LlmCanonicalResult | null;
  inputTokens: number;
  outputTokens: number;
  costMinor: number;
  costCurrency: 'USD';
  latencyMs: number;
  /** The provider's own execution id (opaque string), when it returns one. */
  providerExecutionId: string | null;
  policy: LlmExecutionPolicySnapshot | null;
  routing: LlmRoutingSnapshot;
  invokedBy: string;
  /** ISO 8601 — service clock. */
  invokedAt: string;
}

// ---------------------------------------------------------------------------
// Invocation (the canonical gateway path)
// ---------------------------------------------------------------------------

export interface InvokeLlmInput {
  capability: LlmCapability;
  /** Which Aurum surface is asking (account-scope eligibility check). */
  scope: LlmScope;
  dataClassification: DataClassification;
  /** Required for `text-generation`: 1..64 canonical messages. */
  messages?: CanonicalLlmMessage[];
  /** Required for `embedding`: the text to embed. */
  embeddingInput?: string;
  /** 0..2; null = provider default. `text-generation` only. */
  temperature?: number | null;
  /** 1..32768 AND ≤ the routed model's `maxOutputTokens`. `text-generation` only. */
  maxOutputTokens?: number | null;
  /** Explicit routing pin: use this account (models filtered to it). */
  pinnedAccountId?: string | null;
  /** Explicit routing pin: use this model of the pinned account. */
  pinnedModel?: string | null;
  /**
   * Idempotency key forwarded to the W009 authority gate: with the same
   * key, an invocation the tenant gated behind human approval replays the
   * SAME action request after `decideApproval` (retry then proceeds);
   * without a key every call mints a fresh request.
   */
  idempotencyKey?: string | null;
}

// ---------------------------------------------------------------------------
// Hot-swap verification (GOVERNANCE "provider swap evidence"; W048 seed)
// ---------------------------------------------------------------------------

/** One pinned verification target (account + explicit model). */
export interface HotSwapTarget {
  accountId: string;
  model: string;
}

export interface VerifyProviderHotSwapInput {
  capability: LlmCapability;
  scope: LlmScope;
  dataClassification: DataClassification;
  messages?: CanonicalLlmMessage[];
  embeddingInput?: string;
  temperature?: number | null;
  maxOutputTokens?: number | null;
  targetA: HotSwapTarget;
  targetB: HotSwapTarget;
  idempotencyKey?: string | null;
}

export interface ResolvedHotSwapTarget {
  accountId: string;
  provider: LlmProvider;
  model: string;
}

/**
 * The record of one provider hot-swap verification: the SAME canonical
 * capability request executed through two different (provider, model)
 * targets without any business-code or contract change.
 *
 * `outcome` is a DETERMINISTIC structural comparison, not a semantic
 * judgment: 'equivalent' means both targets completed and produced
 * whitespace-normalized identical text (or identical vectors);
 * 'completed-divergent' means both completed with differing canonical
 * output — the swap still proved (the same provider-neutral contract
 * served both), and semantic judgment stays with the caller/W048;
 * 'failed' means at least one target failed.
 */
export interface LlmHotSwapVerification {
  id: string;
  tenantId: string;
  capability: LlmCapability;
  /** SHA-256 hex digest of the canonical request both targets executed. */
  requestDigest: string;
  targetA: ResolvedHotSwapTarget;
  targetB: ResolvedHotSwapTarget;
  executionAId: string;
  executionBId: string;
  outcome: LlmHotSwapOutcome;
  note: string | null;
  requestedBy: string;
  /** ISO 8601 — service clock. */
  verifiedAt: string;
}

// ---------------------------------------------------------------------------
// Reads: executions, cost/performance summaries, spend
// ---------------------------------------------------------------------------

export interface ListLlmExecutionsQuery {
  provider?: LlmProvider;
  model?: string;
  accountId?: string;
  capability?: LlmCapability;
  status?: LlmExecutionStatus;
  purpose?: LlmExecutionPurpose;
  /** 1..500, default 50. */
  limit?: number;
}

export interface GetLlmExecutionQuery {
  executionId: string;
}

/** Per (provider, model, capability) usage aggregates over the tenant's executions. */
export interface LlmUsageSummaryRow {
  provider: LlmProvider;
  model: string;
  capability: LlmCapability;
  executions: number;
  completed: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  costMinor: number;
  costCurrency: 'USD';
  avgLatencyMs: number | null;
  maxLatencyMs: number | null;
}

export interface LlmUsageSummaryQuery {
  provider?: LlmProvider;
  accountId?: string;
  /** Strict ISO 8601 inclusive bounds on `invokedAt`. */
  since?: string | null;
  until?: string | null;
}

export interface GetAiProviderAccountSpendQuery {
  accountId: string;
}

/** The account's budget posture for the current UTC calendar month. */
export interface AiProviderAccountSpend {
  accountId: string;
  budgetMinor: number | null;
  budgetCurrency: 'USD';
  /** Sum of cost_minor over COMPLETED executions of this month. */
  spendMinor: number;
  /** ISO 8601 — start of the current UTC calendar month. */
  periodStart: string;
  /** Completed executions this month. */
  executions: number;
}

// ---------------------------------------------------------------------------
// Transport port (provider-neutral delivery; implementations are
// module-internal — provider SDKs may only live inside src/modules/llm/)
// ---------------------------------------------------------------------------

/** The kind of provider call being carried (mirrors the capability's endpoint family). */
export type LlmWireRequestKind = 'completion' | 'embedding';

/**
 * The provider-neutral request handed to the transport. `body` is the
 * provider-native JSON the tenant account's ADAPTER built — OPAQUE to the
 * transport and to everything outside the module boundary (lock 28).
 */
export interface LlmTransportRequest {
  provider: LlmProvider;
  accountId: string;
  model: string;
  kind: LlmWireRequestKind;
  body: unknown;
}

/**
 * Provider-neutral outcome of one provider call:
 *  * `delivered` — the provider ACCEPTED the request and returned a payload
 *    (the adapter parses it into a canonical result);
 *  * `rejected`  — the provider refused it (permanent: auth, quota,
 *    content policy …);
 *  * `failed`    — transport error (transient; the gateway may fail over).
 */
export interface LlmTransportReceipt {
  status: 'delivered' | 'rejected' | 'failed';
  /** The provider's native response payload when `delivered`; opaque to the transport contract. */
  payload: unknown;
  providerExecutionId: string | null;
  detail: string | null;
}

/**
 * The delivery port real transports implement. Transports that touch
 * provider SDKs/HTTP must live inside `src/modules/llm/adapters/`
 * (IMPLEMENTATION-STACK §6 provider isolation); they are wired at process
 * start via `setLlmTransport`. No transport is wired by default —
 * invocations then fail explicitly with `provider_unavailable` (the
 * channels module's "as provider availability permits" discipline).
 */
export interface LlmTransport {
  send(request: LlmTransportRequest): Promise<LlmTransportReceipt>;
}
