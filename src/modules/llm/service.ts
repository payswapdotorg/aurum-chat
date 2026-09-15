// Implementation of the llm module's public operations (see contract.ts).
//
// Conventions (IMPLEMENTATION-STACK §3/§8): all SQL goes through the db port
// with `$n` placeholders; ids are uuids minted by PostgreSQL
// (`gen_random_uuid()`); timestamps come from the injectable clock and are
// never caller-supplied; every statement is scoped by the explicit
// TenantContext (ADR-0001) — cross-tenant access is indistinguishable from
// a missing record (`account_not_found` / `execution_not_found` /
// `verification_not_found`), including for action-request references.
//
// W034 acceptance — "Provider/model registry, tenant-owned AI provider
// accounts, routing, availability, performance, cost, policy and hot-swap
// verification" — is carried by these deliberate properties, all tested:
//   1. every AI/LLM provider interaction happens ONLY through this gateway:
//      canonical requests in, canonical evidence out; provider-native wire
//      bodies and response payloads exist only inside `adapters/` and never
//      cross the module boundary (lock 28; IMPLEMENTATION-STACK §6);
//   2. tenant-owned accounts (BYOA, lock 29) carry scopes, capability
//      permissions, data-policy ceilings, budgets, routing preferences —
//      each an independently tested eligibility check (routing.ts);
//   3. no provider/model is privileged (lock 30): routing preference is
//      the tenant's account priority; registry position is only a
//      deterministic same-account tiebreak; with no account there is no
//      default provider to fall back to (Aurum stays usable with ANY set
//      of accounts, and with none it fails explicitly);
//   4. every invocation passes the W009 authority gate (kind
//      'llm-invocation', level ANALYZE — LLM calls are bounded reasoning,
//      ARCHITECTURE.md §19) through `authorizeAction`: approved proceeds,
//      forbidden fails, approval-required waits for a human decision and
//      replays the SAME request when retried with the same idempotency key;
//   5. executions (completed AND failed attempts) are append-only evidence
//      with provider/model metadata, usage, deterministic integer-minor-unit
//      cost, measured latency and the frozen routing decision;
//   6. availability transitions are append-only events; automatic routing
//      skips cooling-down (account, model) pairs and failover walks the
//      ordered candidate list on provider failure;
//   7. hot-swap verification runs the SAME canonical request (SHA-256
//      digest) through two different pinned (provider, model) targets and
//      records a deterministic structural comparison — the module-level
//      provider-swap evidence GOVERNANCE.md demands.

import { createHash } from 'node:crypto';
import { now } from '@/infra/clock';
import { getDb, type DbRow } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import {
  ActionsError,
  authorizeAction,
  type ActionRequest,
  type AuthorityOutcome,
  type PolicyResolutionSource,
} from '@/modules/actions/contract';
import { getLlmAdapter } from './adapters';
import type {
  LlmAdapter,
  WireCompletionResult,
  WireEmbeddingResult,
} from './adapters/types';
import { LlmError } from './errors';
import {
  findLlmModel,
  listLlmModels,
  type LlmModelDescriptor,
  type LlmProvider,
} from './registry';
import {
  availabilityKey,
  CLASSIFICATION_RANK,
  costMinorForUsage,
  monthStartUtc,
  routeLlmRequest,
  type AccountForRouting,
  type AvailabilityForRouting,
} from './routing';
import type {
  AiProviderAccount,
  AiProviderAccountSpend,
  HotSwapTarget,
  InvokeLlmInput,
  LlmAvailability,
  LlmCanonicalResult,
  LlmExecution,
  LlmExecutionPurpose,
  LlmHotSwapOutcome,
  LlmHotSwapVerification,
  LlmRoutingSnapshot,
  LlmTransport,
  LlmUsageSummaryRow,
  RegisterAiProviderAccountInput,
  RegisterAiProviderAccountResult,
  ResolvedHotSwapTarget,
  SetAiAvailabilityInput,
  UpdateAiProviderAccountInput,
  VerifyProviderHotSwapInput,
} from './types';
import {
  assertLlmTenantContext,
  isUuid,
  validateAccountRefQuery,
  validateExecutionRefQuery,
  validateGetAiAvailabilityQuery,
  validateInvokeLlmInput,
  validateListAiProviderAccountsQuery,
  validateListLlmExecutionsQuery,
  validateRegisterAiProviderAccountInput,
  validateSetAiAvailabilityInput,
  validateUpdateAiProviderAccountInput,
  validateUsageSummaryQuery,
  validateVerifyProviderHotSwapInput,
  type ValidatedCanonicalRequest,
  type ValidatedInvokeInput,
  type ValidatedRegisterAccountInput,
  type ValidatedUpdateAccountInput,
  type ValidatedVerifyHotSwapInput,
} from './validation';

// ---------------------------------------------------------------------------
// Module-owned constants (re-exported through the contract)
// ---------------------------------------------------------------------------

/** Authority claim that manages the tenant's AI provider accounts and availability overrides. */
export const LLM_AUTHORITY_ADMINISTER = 'llm:administer';

/** The W009 action kind every gateway invocation passes through. */
export const LLM_ACTION_KIND = 'llm-invocation';

/** Cooldown applied to automatic (execution-observed) unavailability events. */
export const AVAILABILITY_COOLDOWN_MS = 60_000;

// ---------------------------------------------------------------------------
// Rows and mappers
// ---------------------------------------------------------------------------

interface AccountRow extends DbRow {
  id: string;
  tenant_id: string;
  provider: string;
  label: string;
  credential_ref: string;
  status: string;
  scopes: string[];
  capabilities: string[];
  max_data_classification: string;
  priority: number;
  budget_minor: number | null;
  budget_currency: string;
  created_by: string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface AvailabilityEventRow extends DbRow {
  id: string;
  seq: number;
  tenant_id: string;
  account_id: string;
  provider: string;
  model: string;
  state: string;
  reason: string | null;
  source: string;
  expires_at: Date | string | null;
  observed_at: Date | string;
  observed_by: string;
}

interface ExecutionRow extends DbRow {
  id: string;
  seq: number;
  tenant_id: string;
  purpose: string;
  capability: string;
  provider: string;
  model: string;
  account_id: string;
  status: string;
  error_code: string | null;
  error_detail: string | null;
  result: unknown;
  input_tokens: number;
  output_tokens: number;
  cost_minor: number;
  cost_currency: string;
  latency_ms: number;
  provider_execution_id: string | null;
  action_request_id: string | null;
  policy_outcome: string | null;
  policy_resolved_via: string | null;
  routing: unknown;
  invoked_by: string;
  invoked_at: Date | string;
}

interface VerificationRow extends DbRow {
  id: string;
  tenant_id: string;
  capability: string;
  request_digest: string;
  account_a: string;
  provider_a: string;
  model_a: string;
  execution_a: string;
  account_b: string;
  provider_b: string;
  model_b: string;
  execution_b: string;
  outcome: string;
  note: string | null;
  requested_by: string;
  verified_at: Date | string;
}

function toIso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function mapAccount(row: AccountRow): AiProviderAccount {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    provider: row.provider as AiProviderAccount['provider'], // CHECK-constrained by migration 001
    label: row.label,
    credentialRef: row.credential_ref,
    status: row.status as AiProviderAccount['status'], // CHECK-constrained by migration 001
    scopes: row.scopes as AiProviderAccount['scopes'],
    capabilities: row.capabilities as AiProviderAccount['capabilities'],
    maxDataClassification: row.max_data_classification as AiProviderAccount['maxDataClassification'],
    priority: row.priority,
    budgetMinor: row.budget_minor,
    budgetCurrency: 'USD',
    createdBy: row.created_by,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

/** Effective availability: an expired `unavailable` reads as `available` again. */
function mapAvailability(row: AvailabilityEventRow, at: Date): LlmAvailability {
  let state = row.state as LlmAvailability['state'];
  if (state === 'unavailable' && row.expires_at !== null) {
    if (Date.parse(toIso(row.expires_at)) <= at.getTime()) state = 'available';
  }
  return {
    accountId: row.account_id,
    provider: row.provider as LlmProvider,
    model: row.model,
    state,
    reason: row.reason,
    source: row.source as LlmAvailability['source'],
    expiresAt: row.expires_at === null ? null : toIso(row.expires_at),
    observedAt: toIso(row.observed_at),
  };
}

function mapExecution(row: ExecutionRow): LlmExecution {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    purpose: row.purpose as LlmExecution['purpose'], // CHECK-constrained by migration 003
    capability: row.capability as LlmExecution['capability'],
    provider: row.provider as LlmProvider,
    model: row.model,
    accountId: row.account_id,
    status: row.status as LlmExecution['status'],
    errorCode: row.error_code,
    errorDetail: row.error_detail,
    result: (row.result as LlmCanonicalResult | null) ?? null,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    costMinor: row.cost_minor,
    costCurrency: 'USD',
    latencyMs: row.latency_ms,
    providerExecutionId: row.provider_execution_id,
    policy:
      row.action_request_id === null
        ? null
        : {
            actionRequestId: row.action_request_id,
            outcome: row.policy_outcome as 'allowed' | 'approval_required' | 'forbidden',
            resolvedVia: row.policy_resolved_via as 'kind' | 'tenant-default' | 'built-in',
          },
    routing: row.routing as LlmRoutingSnapshot,
    invokedBy: row.invoked_by,
    invokedAt: toIso(row.invoked_at),
  };
}

function mapVerification(row: VerificationRow): LlmHotSwapVerification {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    capability: row.capability as LlmHotSwapVerification['capability'],
    requestDigest: row.request_digest,
    targetA: {
      accountId: row.account_a,
      provider: row.provider_a as LlmProvider,
      model: row.model_a,
    },
    targetB: {
      accountId: row.account_b,
      provider: row.provider_b as LlmProvider,
      model: row.model_b,
    },
    executionAId: row.execution_a,
    executionBId: row.execution_b,
    outcome: row.outcome as LlmHotSwapOutcome,
    note: row.note,
    requestedBy: row.requested_by,
    verifiedAt: toIso(row.verified_at),
  };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function requireAdmin(ctx: TenantContext): void {
  if (!ctx.authority.includes(LLM_AUTHORITY_ADMINISTER)) {
    throw new LlmError(
      'forbidden',
      `managing AI provider accounts and availability requires the '${LLM_AUTHORITY_ADMINISTER}' authority claim`,
    );
  }
}

/** Tenant-scoped account lookup; uniform not-found (no cross-tenant leak). */
async function findAccountRow(accountId: string, ctx: TenantContext): Promise<AccountRow> {
  if (!isUuid(accountId)) {
    throw new LlmError(
      'account_not_found',
      `AI provider account '${accountId}' does not exist in this tenant`,
    );
  }
  const result = await getDb().query<AccountRow>(
    `SELECT * FROM ai_provider_accounts WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, accountId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new LlmError(
      'account_not_found',
      `AI provider account '${accountId}' does not exist in this tenant`,
    );
  }
  return row;
}

// ---------------------------------------------------------------------------
// Transport port (provider-neutral; implementations live inside adapters/)
// ---------------------------------------------------------------------------

let llmTransport: LlmTransport | null = null;

/**
 * Infrastructure wiring for the provider port. Real transports (provider
 * SDKs / HTTP) are implemented inside `src/modules/llm/adapters/` and wired
 * once at process start; tests substitute recording transports. `null`
 * restores the default "no provider available" state.
 */
export function setLlmTransport(transport: LlmTransport | null): void {
  llmTransport = transport;
}

/** The currently wired transport (null when none — invocations then fail `provider_unavailable`). */
export function getLlmTransport(): LlmTransport | null {
  return llmTransport;
}

function requireTransport(): LlmTransport {
  if (llmTransport === null) {
    throw new LlmError(
      'provider_unavailable',
      'no llm transport is wired — wire one via setLlmTransport (as provider availability permits)',
    );
  }
  return llmTransport;
}

/**
 * The provider execution id stored on evidence must be an OPAQUE printable
 * string (the channels module's transport-receipt discipline): a malformed
 * id is an internal invariant violation, never silently persisted.
 */
function sanitizeProviderExecutionId(value: string | null, provider: string): string | null {
  if (value === null) return null;
  if (value.trim() === '' || value.length > 255 || /[\p{Cc}]/u.test(value)) {
    throw new Error(
      `the ${provider} transport returned a malformed provider execution id (internal invariant violation)`,
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// The W009 authority gate
// ---------------------------------------------------------------------------

interface PolicyGate {
  actionRequestId: string;
  outcome: AuthorityOutcome;
  resolvedVia: PolicyResolutionSource;
}

/**
 * Routes one invocation through the tenant's authority matrix (kind
 * 'llm-invocation', level ANALYZE) via the actions module's consequential
 * path — the decision is recorded and auditable, and a caller-supplied
 * idempotency key makes a gated invocation replay the SAME request after a
 * human approval. The payload names what is being approved: capability,
 * scope, data classification, purpose and any explicit routing pin.
 */
async function authorizeInvocation(
  ctx: TenantContext,
  descriptor: Record<string, unknown>,
  idempotencyKey: string | null,
): Promise<PolicyGate> {
  let request: ActionRequest;
  try {
    request = await authorizeAction(ctx, {
      actionKind: LLM_ACTION_KIND,
      authorityLevel: 'ANALYZE',
      payload: descriptor,
      idempotencyKey: idempotencyKey ?? `llm:${newId()}`,
    });
  } catch (error) {
    if (error instanceof ActionsError) {
      if (error.code === 'invalid_context') {
        throw new LlmError('invalid_context', error.message);
      }
      if (error.code === 'invalid_action_input') {
        throw new LlmError('invalid_llm_input', error.message);
      }
      throw new Error(
        `the authority gate rejected a pre-validated llm invocation (internal invariant violation): ${error.message}`,
        { cause: error },
      );
    }
    throw error;
  }
  if (request.status === 'rejected') {
    throw new LlmError(
      'invocation_forbidden',
      `the tenant authority policy forbids ANALYZE of '${LLM_ACTION_KIND}' (request '${request.id}'; decided via ${request.evaluation.resolvedVia})`,
    );
  }
  if (request.status === 'pending') {
    throw new LlmError(
      'invocation_approval_required',
      `action request '${request.id}' (kind '${LLM_ACTION_KIND}', level ANALYZE) awaits a human approval decision — approve it through the actions module, then retry with the same idempotencyKey`,
    );
  }
  return {
    actionRequestId: request.id,
    outcome: request.evaluation.outcome,
    resolvedVia: request.evaluation.resolvedVia,
  };
}

// ---------------------------------------------------------------------------
// Routing inputs (tenant state → the pure router)
// ---------------------------------------------------------------------------

interface RoutingFacts {
  accounts: AiProviderAccount[];
  availability: Map<string, AvailabilityForRouting>;
  spendMinorByAccount: Map<string, number>;
}

async function loadRoutingFacts(ctx: TenantContext): Promise<RoutingFacts> {
  const db = getDb();
  const at = now();
  const accounts = (
    await db.query<AccountRow>(`SELECT * FROM ai_provider_accounts WHERE tenant_id = $1`, [
      ctx.tenantId,
    ])
  ).rows.map(mapAccount);

  // Current availability per (account, model): latest event by seq.
  const availability = new Map<string, AvailabilityForRouting>();
  const eventRows = await db.query<{
    account_id: string;
    model: string;
    state: string;
    expires_at: Date | string | null;
  }>(
    `SELECT DISTINCT ON (account_id, model) account_id, model, state, expires_at
       FROM llm_availability_events
       WHERE tenant_id = $1
       ORDER BY account_id, model, seq DESC`,
    [ctx.tenantId],
  );
  for (const row of eventRows.rows) {
    availability.set(availabilityKey(row.account_id, row.model), {
      state: row.state as 'available' | 'unavailable',
      expiresAt: row.expires_at === null ? null : toIso(row.expires_at),
    });
  }

  // Spend per account for the current UTC calendar month (budget periods).
  const spend = new Map<string, number>();
  const spendRows = await db.query<{ account_id: string; spend: number }>(
    `SELECT account_id, COALESCE(SUM(cost_minor), 0)::integer AS spend
       FROM llm_executions
       WHERE tenant_id = $1 AND status = 'completed' AND invoked_at >= $2
       GROUP BY account_id`,
    [ctx.tenantId, monthStartUtc(at)],
  );
  for (const row of spendRows.rows) spend.set(row.account_id, row.spend);

  return { accounts, availability, spendMinorByAccount: spend };
}

function providerModelsIndex(): Map<LlmProvider, readonly LlmModelDescriptor[]> {
  const index = new Map<LlmProvider, readonly LlmModelDescriptor[]>();
  for (const provider of new Set(listLlmModels().map((model) => model.provider))) {
    index.set(provider, listLlmModels(provider));
  }
  return index;
}

function accountForRouting(account: AiProviderAccount): AccountForRouting {
  return {
    id: account.id,
    provider: account.provider,
    status: account.status,
    scopes: account.scopes,
    capabilities: account.capabilities,
    maxDataClassification: account.maxDataClassification,
    priority: account.priority,
    budgetMinor: account.budgetMinor,
    createdAt: account.createdAt,
  };
}

function noEligibleAccountError(capability: string, snapshot: LlmRoutingSnapshot): LlmError {
  const reasons = [
    ...new Set(
      snapshot.candidates
        .filter((candidate) => !candidate.eligible)
        .map((candidate) => candidate.reason),
    ),
  ];
  const reasonText =
    reasons.length > 0 ? `; rejection reasons: ${reasons.join(', ')}` : '';
  return new LlmError(
    'no_eligible_account',
    `no eligible (account, model) serves capability '${capability}' in this tenant (${snapshot.candidates.length} candidate(s) considered${reasonText}) — register or enable an AI provider account that permits the capability, scope, data classification and output limit`,
  );
}

// ---------------------------------------------------------------------------
// Availability event recording (append-only transitions)
// ---------------------------------------------------------------------------

async function recordAvailability(
  ctx: TenantContext,
  account: AiProviderAccount,
  model: string,
  state: 'available' | 'unavailable',
  reason: string,
  source: 'execution' | 'manual',
  expiresAt: Date | null,
  observedAt: Date,
): Promise<void> {
  await getDb().query(
    `INSERT INTO llm_availability_events (
       tenant_id, account_id, provider, model, state, reason, source,
       expires_at, observed_at, observed_by
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      ctx.tenantId,
      account.id,
      account.provider,
      model,
      state,
      reason.slice(0, 500),
      source,
      expiresAt,
      observedAt,
      ctx.principalId,
    ],
  );
}

// ---------------------------------------------------------------------------
// The execution attempt (shared by invoke and hot-swap verification)
// ---------------------------------------------------------------------------

interface AttemptOutcome {
  execution: LlmExecution;
  completed: boolean;
  errorCode: string | null;
}

interface AttemptRequest {
  purpose: LlmExecutionPurpose;
  canonical: ValidatedCanonicalRequest;
  snapshot: LlmRoutingSnapshot;
  policy: PolicyGate | null;
  candidate: { accountId: string; provider: LlmProvider; model: string };
  account: AiProviderAccount;
  /** Latest pre-invocation availability state (drives recovery recording). */
  wasUnavailable: boolean;
}

/**
 * Runs ONE provider interaction on a pinned candidate and records its
 * append-only execution evidence — completed or failed. Provider-native
 * wire bodies and payloads stay inside the adapter pair; only canonical
 * values are persisted. Automatic failures insert an `unavailable` event
 * with the cooldown; a success on a previously unavailable target inserts
 * the recovery event.
 */
async function attemptExecution(
  ctx: TenantContext,
  request: AttemptRequest,
): Promise<AttemptOutcome> {
  const descriptor = findLlmModel(request.candidate.provider, request.candidate.model);
  if (descriptor === null) {
    // Routing only proposes registry models; reaching here is an internal bug.
    throw new Error(
      `routing proposed unregistered model '${request.candidate.provider}:${request.candidate.model}' (internal invariant violation)`,
    );
  }
  const adapter: LlmAdapter = getLlmAdapter(request.candidate.provider);
  const transport = requireTransport();

  const kind: 'completion' | 'embedding' =
    request.canonical.capability === 'text-generation' ? 'completion' : 'embedding';
  const effectiveMaxOutputTokens =
    request.canonical.capability === 'text-generation'
      ? request.canonical.maxOutputTokens ?? descriptor.maxOutputTokens
      : 0;
  const wireBody =
    kind === 'completion'
      ? adapter.buildCompletionRequest({
          model: descriptor.modelId,
          messages: request.canonical.messages ?? [],
          temperature: request.canonical.temperature,
          maxOutputTokens: effectiveMaxOutputTokens,
        })
      : adapter.buildEmbeddingRequest({
          model: descriptor.modelId,
          input: request.canonical.embeddingInput ?? '',
        });

  // The one provider call — measured; transport-level failures are receipts.
  const startedAt = now().getTime();
  const receipt = await transport.send({
    provider: request.candidate.provider,
    accountId: request.candidate.accountId,
    model: descriptor.modelId,
    kind,
    body: wireBody,
  });
  const latencyMs = Math.max(0, now().getTime() - startedAt);

  let result: LlmCanonicalResult | null = null;
  let usage = { inputTokens: 0, outputTokens: 0 };
  let providerExecutionId: string | null = null;
  let errorCode: string | null = null;
  let errorDetail: string | null = null;

  if (receipt.status === 'delivered') {
    try {
      if (kind === 'completion') {
        const parsed: WireCompletionResult = adapter.parseCompletionResponse(receipt.payload);
        result = { kind: 'text-generation', text: parsed.text };
        usage = parsed.usage;
        providerExecutionId = sanitizeProviderExecutionId(
          parsed.providerExecutionId ?? receipt.providerExecutionId,
          request.candidate.provider,
        );
      } else {
        const parsed: WireEmbeddingResult = adapter.parseEmbeddingResponse(receipt.payload);
        result = { kind: 'embedding', vector: parsed.vector };
        usage = parsed.usage;
        providerExecutionId = sanitizeProviderExecutionId(
          parsed.providerExecutionId ?? receipt.providerExecutionId,
          request.candidate.provider,
        );
      }
    } catch (error) {
      if (error instanceof LlmError && error.code === 'provider_malformed_response') {
        errorCode = 'provider_malformed_response';
        errorDetail = error.message;
      } else {
        throw error;
      }
    }
  } else if (receipt.status === 'rejected') {
    errorCode = 'invocation_rejected';
    errorDetail = receipt.detail ?? `the ${request.candidate.provider} transport refused the request`;
  } else {
    errorCode = 'invocation_failed';
    errorDetail = receipt.detail ?? `the ${request.candidate.provider} transport failed (transient)`;
  }

  const completed = errorCode === null;
  const costMinor = completed
    ? costMinorForUsage(descriptor, usage.inputTokens, usage.outputTokens)
    : 0;

  const inserted = await getDb().query<ExecutionRow>(
    `INSERT INTO llm_executions (
       tenant_id, purpose, capability, provider, model, account_id, status,
       error_code, error_detail, result, input_tokens, output_tokens,
       cost_minor, cost_currency, latency_ms, provider_execution_id,
       action_request_id, policy_outcome, policy_resolved_via, routing,
       invoked_by, invoked_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12,
               $13, 'USD', $14, $15, $16, $17, $18, $19::jsonb, $20, $21)
     RETURNING *`,
    [
      ctx.tenantId,
      request.purpose,
      request.canonical.capability,
      request.candidate.provider,
      descriptor.modelId,
      request.candidate.accountId,
      completed ? 'completed' : 'failed',
      errorCode,
      errorDetail,
      result === null ? null : JSON.stringify(result),
      usage.inputTokens,
      usage.outputTokens,
      costMinor,
      latencyMs,
      providerExecutionId,
      request.policy === null ? null : request.policy.actionRequestId,
      request.policy === null ? null : request.policy.outcome,
      request.policy === null ? null : request.policy.resolvedVia,
      JSON.stringify(request.snapshot),
      ctx.principalId,
      now(),
    ],
  );
  const execution = mapExecution(inserted.rows[0]!);

  // Availability transitions (append-only evidence).
  if (!completed) {
    await recordAvailability(
      ctx,
      request.account,
      descriptor.modelId,
      'unavailable',
      `${errorCode}: ${errorDetail ?? 'provider failure'}`,
      'execution',
      new Date(now().getTime() + AVAILABILITY_COOLDOWN_MS),
      now(),
    );
  } else if (request.wasUnavailable) {
    await recordAvailability(
      ctx,
      request.account,
      descriptor.modelId,
      'available',
      'recovered after successful execution',
      'execution',
      null,
      now(),
    );
  }

  return { execution, completed, errorCode };
}

// ---------------------------------------------------------------------------
// Accounts (BYOA)
// ---------------------------------------------------------------------------

export async function registerAiProviderAccount(
  ctx: TenantContext,
  input: RegisterAiProviderAccountInput,
): Promise<RegisterAiProviderAccountResult> {
  assertLlmTenantContext(ctx);
  requireAdmin(ctx);
  const valid: ValidatedRegisterAccountInput = validateRegisterAiProviderAccountInput(input);
  // The registry is closed: a provider without an adapter cannot be routed.
  if (listLlmModels(valid.provider).length === 0) {
    throw new LlmError(
      'unsupported_provider',
      `the registry carries no models for provider '${valid.provider}'`,
    );
  }

  const at = now();
  const db = getDb();
  // ON CONFLICT DO NOTHING collapses duplicate registrations (first
  // registration wins — the channels module's idempotent endpoint rule).
  const inserted = await db.query<AccountRow>(
    `INSERT INTO ai_provider_accounts (
       tenant_id, provider, label, credential_ref, status, scopes,
       capabilities, max_data_classification, priority, budget_minor,
       budget_currency, created_by, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, 'active', $5, $6, $7, $8, $9, 'USD', $10, $11, $11)
     ON CONFLICT (tenant_id, provider, label) DO NOTHING
     RETURNING *`,
    [
      ctx.tenantId,
      valid.provider,
      valid.label,
      valid.credentialRef,
      valid.scopes,
      valid.capabilities,
      valid.maxDataClassification,
      valid.priority,
      valid.budgetMinor,
      ctx.principalId,
      at,
    ],
  );
  const row = inserted.rows[0];
  if (row !== undefined) {
    return { account: mapAccount(row), created: true };
  }
  const existing = await db.query<AccountRow>(
    `SELECT * FROM ai_provider_accounts
       WHERE tenant_id = $1 AND provider = $2 AND label = $3`,
    [ctx.tenantId, valid.provider, valid.label],
  );
  const winner = existing.rows[0];
  if (winner === undefined) {
    // Unreachable barring a delete path (none exists today); stay loud rather than wrong.
    throw new Error('ai provider account disappeared after a duplicate-registration conflict');
  }
  return { account: mapAccount(winner), created: false };
}

export async function getAiProviderAccount(
  ctx: TenantContext,
  query: { accountId: string },
): Promise<AiProviderAccount> {
  assertLlmTenantContext(ctx);
  const valid = validateAccountRefQuery(query);
  const row = await findAccountRow(valid.accountId, ctx);
  return mapAccount(row);
}

export async function listAiProviderAccounts(
  ctx: TenantContext,
  query: { provider?: LlmProvider; status?: AiProviderAccount['status']; limit?: number },
): Promise<AiProviderAccount[]> {
  assertLlmTenantContext(ctx);
  const valid = validateListAiProviderAccountsQuery(query);

  const conditions: string[] = ['tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  if (valid.provider !== null) {
    params.push(valid.provider);
    conditions.push(`provider = $${params.length}`);
  }
  if (valid.status !== null) {
    params.push(valid.status);
    conditions.push(`status = $${params.length}`);
  }
  params.push(valid.limit);
  const limitPlaceholder = `$${params.length}`;

  const rows = await getDb().query<AccountRow>(
    `SELECT * FROM ai_provider_accounts WHERE ${conditions.join(' AND ')}
       ORDER BY priority ASC, created_at ASC, id ASC LIMIT ${limitPlaceholder}`,
    params,
  );
  return rows.rows.map(mapAccount);
}

export async function updateAiProviderAccount(
  ctx: TenantContext,
  input: UpdateAiProviderAccountInput,
): Promise<AiProviderAccount> {
  assertLlmTenantContext(ctx);
  requireAdmin(ctx);
  const valid: ValidatedUpdateAccountInput = validateUpdateAiProviderAccountInput(input);

  const sets: string[] = [];
  const params: unknown[] = [];
  const add = (column: string, value: unknown): void => {
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  };
  if (valid.credentialRef !== null) add('credential_ref', valid.credentialRef);
  if (valid.scopes !== null) add('scopes', valid.scopes);
  if (valid.capabilities !== null) add('capabilities', valid.capabilities);
  if (valid.maxDataClassification !== null) {
    add('max_data_classification', valid.maxDataClassification);
  }
  if (valid.priority !== null) add('priority', valid.priority);
  if (valid.budgetProvided) add('budget_minor', valid.budgetMinor);
  if (valid.status !== null) add('status', valid.status);
  add('updated_at', now());

  params.push(ctx.tenantId, valid.accountId);
  const tenantPlaceholder = `$${params.length - 1}`;
  const idPlaceholder = `$${params.length}`;

  const result = await getDb().query<AccountRow>(
    `UPDATE ai_provider_accounts SET ${sets.join(', ')}
       WHERE tenant_id = ${tenantPlaceholder} AND id = ${idPlaceholder}
       RETURNING *`,
    params,
  );
  const row = result.rows[0];
  if (row === undefined) {
    // Cross-tenant accounts are indistinguishable from missing ones.
    throw new LlmError(
      'account_not_found',
      `AI provider account '${valid.accountId}' does not exist in this tenant`,
    );
  }
  return mapAccount(row);
}

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

export async function setAiAvailability(
  ctx: TenantContext,
  input: SetAiAvailabilityInput,
): Promise<LlmAvailability> {
  assertLlmTenantContext(ctx);
  requireAdmin(ctx);
  const valid = validateSetAiAvailabilityInput(input);

  const accountRow = await findAccountRow(valid.accountId, ctx);
  const account = mapAccount(accountRow);
  if (findLlmModel(account.provider, valid.model) === null) {
    throw new LlmError(
      'unsupported_model',
      `the registry carries no model '${valid.model}' for provider '${account.provider}'`,
    );
  }

  const at = now();
  const expiresAt =
    valid.state === 'unavailable' && valid.expiresAt !== null
      ? new Date(Date.parse(valid.expiresAt))
      : null;
  const reason = valid.reason ?? `manual ${valid.state} override`;
  await recordAvailability(
    ctx,
    account,
    valid.model,
    valid.state,
    reason,
    'manual',
    expiresAt,
    at,
  );

  return {
    accountId: account.id,
    provider: account.provider,
    model: valid.model,
    state: valid.state,
    reason,
    source: 'manual',
    expiresAt: valid.expiresAt,
    observedAt: at.toISOString(),
  };
}

export async function getAiAvailability(
  ctx: TenantContext,
  query: { accountId?: string | null },
): Promise<LlmAvailability[]> {
  assertLlmTenantContext(ctx);
  const valid = validateGetAiAvailabilityQuery(query);
  if (valid.accountId !== null) {
    // Uniform not-found for foreign/missing accounts (no leak).
    await findAccountRow(valid.accountId, ctx);
  }

  const at = now();
  const rows =
    valid.accountId === null
      ? await getDb().query<AvailabilityEventRow>(
          `SELECT DISTINCT ON (account_id, model) * FROM llm_availability_events
             WHERE tenant_id = $1
             ORDER BY account_id, model, seq DESC`,
          [ctx.tenantId],
        )
      : await getDb().query<AvailabilityEventRow>(
          `SELECT DISTINCT ON (account_id, model) * FROM llm_availability_events
             WHERE tenant_id = $1 AND account_id = $2
             ORDER BY account_id, model, seq DESC`,
          [ctx.tenantId, valid.accountId],
        );
  return rows.rows.map((row) => mapAvailability(row, at));
}

// ---------------------------------------------------------------------------
// Invocation (the canonical gateway path)
// ---------------------------------------------------------------------------

export async function invokeLlm(
  ctx: TenantContext,
  input: InvokeLlmInput,
): Promise<LlmExecution> {
  assertLlmTenantContext(ctx);
  const valid: ValidatedInvokeInput = validateInvokeLlmInput(input);

  // The W009 authority gate: ANALYZE-level, recorded, idempotent on the
  // caller's key (a gated invocation replays the same request after
  // approval and then proceeds).
  const gate = await authorizeInvocation(
    ctx,
    {
      capability: valid.capability,
      scope: valid.scope,
      dataClassification: valid.dataClassification,
      purpose: 'invocation',
      pinnedAccountId: valid.pinnedAccountId,
      pinnedModel: valid.pinnedModel,
    },
    valid.idempotencyKey,
  );

  // Fail fast on the unwired-transport state before anything is recorded.
  requireTransport();

  // An explicit pin must address an existing account of this tenant
  // (uniform not-found) — and a pinned model must exist in its registry.
  if (valid.pinnedAccountId !== null) {
    const pinnedAccount = mapAccount(await findAccountRow(valid.pinnedAccountId, ctx));
    if (pinnedAccount.status !== 'active') {
      throw new LlmError(
        'account_disabled',
        `AI provider account '${pinnedAccount.id}' (${pinnedAccount.provider}/${pinnedAccount.label}) is disabled`,
      );
    }
    if (valid.pinnedModel !== null && findLlmModel(pinnedAccount.provider, valid.pinnedModel) === null) {
      throw new LlmError(
        'unsupported_model',
        `the registry carries no model '${valid.pinnedModel}' for provider '${pinnedAccount.provider}'`,
      );
    }
  }

  const facts = await loadRoutingFacts(ctx);
  const decision = routeLlmRequest({
    capability: valid.capability,
    scope: valid.scope,
    dataClassification: valid.dataClassification,
    accounts: facts.accounts.map(accountForRouting),
    availability: facts.availability,
    spendMinorByAccount: facts.spendMinorByAccount,
    providerModels: providerModelsIndex(),
    at: now(),
    pinnedAccountId: valid.pinnedAccountId,
    pinnedModel: valid.pinnedModel,
    maxOutputTokens: valid.maxOutputTokens,
  });
  if (decision.orderedEligible.length === 0) {
    throw noEligibleAccountError(valid.capability, decision.snapshot);
  }

  const accountById = new Map(facts.accounts.map((account) => [account.id, account] as const));
  let lastErrorCode: string | null = null;
  let lastErrorDetail: string | null = null;

  for (const candidate of decision.orderedEligible) {
    const account = accountById.get(candidate.accountId);
    if (account === undefined) {
      throw new Error(
        'routing proposed an account that vanished inside one invocation (internal invariant violation)',
      );
    }
    const snapshot: LlmRoutingSnapshot = {
      pinned: decision.snapshot.pinned,
      candidates: decision.snapshot.candidates,
      chosen: candidate,
    };
    const outcome = await attemptExecution(ctx, {
      purpose: 'invocation',
      canonical: valid,
      snapshot,
      policy: gate,
      candidate,
      account,
      wasUnavailable:
        facts.availability.get(availabilityKey(candidate.accountId, candidate.model))?.state ===
        'unavailable',
    });
    if (outcome.completed) {
      return outcome.execution;
    }
    lastErrorCode = outcome.errorCode;
    lastErrorDetail = outcome.execution.errorDetail;
  }

  const finalCode = lastErrorCode === 'invocation_rejected' ? 'invocation_rejected' : 'invocation_failed';
  throw new LlmError(
    finalCode,
    `every eligible candidate failed (${decision.orderedEligible.length} attempt(s))${
      lastErrorDetail === null ? '' : `; last failure: ${lastErrorDetail}`
    } (failed attempts are recorded as evidence)`,
  );
}

// ---------------------------------------------------------------------------
// Hot-swap verification (GOVERNANCE "provider swap evidence"; W048 seed)
// ---------------------------------------------------------------------------

/** SHA-256 hex digest of the canonical request — proves both targets ran the same bytes. */
function canonicalRequestDigest(valid: ValidatedCanonicalRequest): string {
  const canonical = {
    capability: valid.capability,
    scope: valid.scope,
    dataClassification: valid.dataClassification,
    messages: valid.messages,
    embeddingInput: valid.embeddingInput,
    temperature: valid.temperature,
    maxOutputTokens: valid.maxOutputTokens,
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/** Deterministic structural comparison (semantic judgment stays with the caller). */
function compareResults(
  capability: ValidatedCanonicalRequest['capability'],
  a: LlmCanonicalResult,
  b: LlmCanonicalResult,
): LlmHotSwapOutcome {
  if (capability === 'text-generation') {
    const normalize = (result: LlmCanonicalResult): string =>
      result.kind === 'text-generation' ? result.text.trim().replace(/\s+/g, ' ') : '';
    return normalize(a) === normalize(b) ? 'equivalent' : 'completed-divergent';
  }
  const left = a.kind === 'embedding' ? a.vector : [];
  const right = b.kind === 'embedding' ? b.vector : [];
  const same =
    left.length === right.length && left.every((value, index) => value === right[index]);
  return same ? 'equivalent' : 'completed-divergent';
}

export interface VerifyProviderHotSwapResult {
  verification: LlmHotSwapVerification;
  executionA: LlmExecution;
  executionB: LlmExecution;
}

export async function verifyProviderHotSwap(
  ctx: TenantContext,
  input: VerifyProviderHotSwapInput,
): Promise<VerifyProviderHotSwapResult> {
  assertLlmTenantContext(ctx);
  const valid: ValidatedVerifyHotSwapInput = validateVerifyProviderHotSwapInput(input);

  const gate = await authorizeInvocation(
    ctx,
    {
      capability: valid.capability,
      scope: valid.scope,
      dataClassification: valid.dataClassification,
      purpose: 'hot-swap-verification',
    },
    valid.idempotencyKey,
  );
  requireTransport();

  const resolveTarget = async (target: HotSwapTarget): Promise<{
    account: AiProviderAccount;
    descriptor: LlmModelDescriptor;
  }> => {
    // Uniform not-found for foreign/missing accounts (no leak).
    const account = mapAccount(await findAccountRow(target.accountId, ctx));
    if (account.status !== 'active') {
      throw new LlmError(
        'account_disabled',
        `verification target account '${account.id}' (${account.provider}/${account.label}) is disabled`,
      );
    }
    const descriptor = findLlmModel(account.provider, target.model);
    if (descriptor === null) {
      throw new LlmError(
        'unsupported_model',
        `the registry carries no model '${target.model}' for provider '${account.provider}'`,
      );
    }
    if (!(descriptor.capabilities as readonly string[]).includes(valid.capability)) {
      throw new LlmError(
        'unsupported_capability',
        `model '${target.model}' does not support capability '${valid.capability}'`,
      );
    }
    if (!(account.capabilities as readonly string[]).includes(valid.capability)) {
      throw new LlmError(
        'no_eligible_account',
        `verification target account '${account.id}' does not permit capability '${valid.capability}'`,
      );
    }
    if (!(account.scopes as readonly string[]).includes(valid.scope)) {
      throw new LlmError(
        'no_eligible_account',
        `verification target account '${account.id}' does not permit scope '${valid.scope}'`,
      );
    }
    if (
      CLASSIFICATION_RANK[valid.dataClassification] >
      CLASSIFICATION_RANK[account.maxDataClassification]
    ) {
      throw new LlmError(
        'no_eligible_account',
        `verification target account '${account.id}' data policy (${account.maxDataClassification}) does not permit classification '${valid.dataClassification}'`,
      );
    }
    if (
      valid.capability === 'text-generation' &&
      valid.maxOutputTokens !== null &&
      valid.maxOutputTokens > descriptor.maxOutputTokens
    ) {
      throw new LlmError(
        'model_output_limit',
        `verification target model '${target.model}' caps output at ${descriptor.maxOutputTokens} tokens (requested ${valid.maxOutputTokens})`,
      );
    }
    return { account, descriptor };
  };

  const resolvedA = await resolveTarget(valid.targetA);
  const resolvedB = await resolveTarget(valid.targetB);
  if (
    resolvedA.account.provider === resolvedB.account.provider &&
    resolvedA.descriptor.modelId === resolvedB.descriptor.modelId
  ) {
    throw new LlmError(
      'invalid_llm_input',
      'the two verification targets resolve to the same (provider, model) — a hot-swap needs different targets',
    );
  }

  const digest = canonicalRequestDigest(valid);
  const facts = await loadRoutingFacts(ctx);

  const runTarget = async (target: {
    account: AiProviderAccount;
    descriptor: LlmModelDescriptor;
  }): Promise<{ execution: LlmExecution; resolved: ResolvedHotSwapTarget }> => {
    const candidate = {
      accountId: target.account.id,
      provider: target.account.provider,
      model: target.descriptor.modelId,
    };
    const outcome = await attemptExecution(ctx, {
      purpose: 'hot-swap-verification',
      canonical: valid,
      snapshot: {
        pinned: true,
        candidates: [
          { ...candidate, eligible: true, reason: null },
        ],
        chosen: candidate,
      },
      policy: gate,
      candidate,
      account: target.account,
      // Pinned verification deliberately bypasses availability exclusion
      // (an explicit pin is an operator instruction — documented behavior).
      wasUnavailable:
        facts.availability.get(availabilityKey(candidate.accountId, candidate.model))?.state ===
        'unavailable',
    });
    return {
      execution: outcome.execution,
      resolved: { accountId: candidate.accountId, provider: candidate.provider, model: candidate.model },
    };
  };

  // Sequential, pinned, no failover: each target's outcome is evidence.
  const runA = await runTarget(resolvedA);
  const runB = await runTarget(resolvedB);

  const outcome: LlmHotSwapOutcome =
    runA.execution.status === 'completed' && runB.execution.status === 'completed' && runA.execution.result !== null && runB.execution.result !== null
      ? compareResults(valid.capability, runA.execution.result, runB.execution.result)
      : 'failed';

  const note =
    outcome === 'equivalent'
      ? 'both targets completed with structurally identical canonical output'
      : outcome === 'completed-divergent'
        ? 'both targets completed; canonical outputs differ textually — the swap still proved (same contract, same request), semantic judgment stays with the caller'
        : 'at least one target failed — see the recorded executions';

  const inserted = await getDb().query<VerificationRow>(
    `INSERT INTO llm_hot_swap_verifications (
       tenant_id, capability, request_digest,
       account_a, provider_a, model_a, execution_a,
       account_b, provider_b, model_b, execution_b,
       outcome, note, requested_by, verified_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     RETURNING *`,
    [
      ctx.tenantId,
      valid.capability,
      digest,
      runA.resolved.accountId,
      runA.resolved.provider,
      runA.resolved.model,
      runA.execution.id,
      runB.resolved.accountId,
      runB.resolved.provider,
      runB.resolved.model,
      runB.execution.id,
      outcome,
      note,
      ctx.principalId,
      now(),
    ],
  );

  return {
    verification: mapVerification(inserted.rows[0]!),
    executionA: runA.execution,
    executionB: runB.execution,
  };
}

// ---------------------------------------------------------------------------
// Execution reads: evidence, cost, performance
// ---------------------------------------------------------------------------

export async function getLlmExecution(
  ctx: TenantContext,
  query: { executionId: string },
): Promise<LlmExecution> {
  assertLlmTenantContext(ctx);
  const valid = validateExecutionRefQuery(query);
  if (!isUuid(valid.executionId)) {
    throw new LlmError(
      'execution_not_found',
      `llm execution '${valid.executionId}' does not exist in this tenant`,
    );
  }
  const result = await getDb().query<ExecutionRow>(
    `SELECT * FROM llm_executions WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, valid.executionId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new LlmError(
      'execution_not_found',
      `llm execution '${valid.executionId}' does not exist in this tenant`,
    );
  }
  return mapExecution(row);
}

export async function listLlmExecutions(
  ctx: TenantContext,
  query: Parameters<typeof validateListLlmExecutionsQuery>[0],
): Promise<LlmExecution[]> {
  assertLlmTenantContext(ctx);
  const valid = validateListLlmExecutionsQuery(query);

  const conditions: string[] = ['tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  const add = (fragment: string, value: unknown): void => {
    params.push(value);
    conditions.push(fragment.replace('$#', `$${params.length}`));
  };
  if (valid.provider !== null) add('provider = $#', valid.provider);
  if (valid.model !== null) add('model = $#', valid.model);
  if (valid.accountId !== null) add('account_id = $#', valid.accountId);
  if (valid.capability !== null) add('capability = $#', valid.capability);
  if (valid.status !== null) add('status = $#', valid.status);
  if (valid.purpose !== null) add('purpose = $#', valid.purpose);
  params.push(valid.limit);
  const limitPlaceholder = `$${params.length}`;

  const rows = await getDb().query<ExecutionRow>(
    `SELECT * FROM llm_executions WHERE ${conditions.join(' AND ')}
       ORDER BY invoked_at DESC, seq DESC LIMIT ${limitPlaceholder}`,
    params,
  );
  return rows.rows.map(mapExecution);
}

export async function getLlmUsageSummary(
  ctx: TenantContext,
  query: Parameters<typeof validateUsageSummaryQuery>[0],
): Promise<LlmUsageSummaryRow[]> {
  assertLlmTenantContext(ctx);
  const valid = validateUsageSummaryQuery(query);

  const conditions: string[] = ['tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  const add = (fragment: string, value: unknown): void => {
    params.push(value);
    conditions.push(fragment.replace('$#', `$${params.length}`));
  };
  if (valid.provider !== null) add('provider = $#', valid.provider);
  if (valid.accountId !== null) add('account_id = $#', valid.accountId);
  if (valid.since !== null) add('invoked_at >= $#', new Date(Date.parse(valid.since)));
  if (valid.until !== null) add('invoked_at <= $#', new Date(Date.parse(valid.until)));

  const rows = await getDb().query<{
    provider: string;
    model: string;
    capability: string;
    executions: number;
    completed: number;
    failed: number;
    input_tokens: number;
    output_tokens: number;
    cost_minor: number;
    avg_latency_ms: number | null;
    max_latency_ms: number | null;
  }>(
    `SELECT provider, model, capability,
        COUNT(*)::integer AS executions,
        COUNT(*) FILTER (WHERE status = 'completed')::integer AS completed,
        COUNT(*) FILTER (WHERE status = 'failed')::integer AS failed,
        COALESCE(SUM(input_tokens), 0)::integer AS input_tokens,
        COALESCE(SUM(output_tokens), 0)::integer AS output_tokens,
        COALESCE(SUM(cost_minor), 0)::integer AS cost_minor,
        (AVG(latency_ms))::integer AS avg_latency_ms,
        MAX(latency_ms)::integer AS max_latency_ms
       FROM llm_executions
       WHERE ${conditions.join(' AND ')}
       GROUP BY provider, model, capability
       ORDER BY provider ASC, model ASC, capability ASC`,
    params,
  );

  return rows.rows.map((row) => ({
    provider: row.provider as LlmProvider,
    model: row.model,
    capability: row.capability as LlmUsageSummaryRow['capability'],
    executions: row.executions,
    completed: row.completed,
    failed: row.failed,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    costMinor: row.cost_minor,
    costCurrency: 'USD' as const,
    avgLatencyMs: row.avg_latency_ms,
    maxLatencyMs: row.max_latency_ms,
  }));
}

export async function getAiProviderAccountSpend(
  ctx: TenantContext,
  query: { accountId: string },
): Promise<AiProviderAccountSpend> {
  assertLlmTenantContext(ctx);
  const valid = validateAccountRefQuery(query);
  const row = await findAccountRow(valid.accountId, ctx);
  const account = mapAccount(row);

  const periodStart = monthStartUtc(now());
  const spend = await getDb().query<{ spend: number; executions: number }>(
    `SELECT COALESCE(SUM(cost_minor), 0)::integer AS spend, COUNT(*)::integer AS executions
       FROM llm_executions
       WHERE tenant_id = $1 AND account_id = $2 AND status = 'completed'
         AND invoked_at >= $3`,
    [ctx.tenantId, account.id, periodStart],
  );
  const totals = spend.rows[0] ?? { spend: 0, executions: 0 };
  return {
    accountId: account.id,
    budgetMinor: account.budgetMinor,
    budgetCurrency: 'USD',
    spendMinor: totals.spend,
    periodStart: periodStart.toISOString(),
    executions: totals.executions,
  };
}

// ---------------------------------------------------------------------------
// Hot-swap verification reads
// ---------------------------------------------------------------------------

export async function getHotSwapVerification(
  ctx: TenantContext,
  query: { verificationId: string },
): Promise<LlmHotSwapVerification> {
  assertLlmTenantContext(ctx);
  if (!isPlainObjectQuery(query)) {
    throw new LlmError('invalid_llm_query', 'query must be an object');
  }
  const verificationId = query.verificationId;
  if (typeof verificationId !== 'string' || !isUuid(verificationId)) {
    throw new LlmError(
      'verification_not_found',
      `hot-swap verification '${String(verificationId)}' does not exist in this tenant`,
    );
  }
  const result = await getDb().query<VerificationRow>(
    `SELECT * FROM llm_hot_swap_verifications WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, verificationId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new LlmError(
      'verification_not_found',
      `hot-swap verification '${verificationId}' does not exist in this tenant`,
    );
  }
  return mapVerification(row);
}

function isPlainObjectQuery(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}
