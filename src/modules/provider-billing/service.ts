// Implementation of the provider-billing module's public operations (see
// contract.ts). W090 — Aurum Provider Billing Gateway.
//
// Conventions (IMPLEMENTATION-STACK §3/§8): all SQL goes through the db
// port with `$n` placeholders; ids are uuids minted by PostgreSQL
// (`gen_random_uuid()`) or `newId()` where the charge handshake needs the
// id first; timestamps come from the injectable clock and are never
// caller-supplied (except usage `occurredAt`, which is the usage's
// business time and defaults to the clock); every statement is scoped by
// the explicit TenantContext (ADR-0001) — cross-tenant access is
// indistinguishable from a missing record, no existence leak.
//
// W090 acceptance — "provider cost can be attributed to
// tenant/capability/execution; budget policy can block/route usage;
// supported provider settlement produces an auditable receipt;
// unsupported direct-billing provider does not break capability flow" —
// is carried by these deliberate properties, all tested:
//
//   1. COST ATTRIBUTION: `recordProviderUsage` appends to the usage
//      ledger with (gateway, provider, capability, executionRef,
//      accountRef, costMinor) — idempotent by (tenant, gateway,
//      dedupeKey), first write wins. Usage attribution NEVER requires a
//      payment arrangement (capability flow cannot break); summaries
//      aggregate per (gateway, provider, capability) with distinct
//      execution counts, and `importLlmUsage` pulls the W034 llm
//      gateway's completed executions into the same ledger through its
//      public contract.
//
//   2. BUDGET POLICY: tenant budget rows at four scopes (tenant, gateway,
//      provider, capability) with 'block'/'observe' enforcement. EVERY
//      active covering row is evaluated (no shadowing); a 'block' row
//      that the projected cost would exceed blocks the usage with a
//      deterministic reason; 'observe' rows over budget warn.
//      `routeWithinBudget` filters candidate targets in input order
//      (read-only routing). Enforcement outcomes that bit are recorded
//      as append-only budget events with the frozen evaluation snapshot.
//      The evaluation is a pure function of (rows, spend, request,
//      period) — no clock reads, no LLM, no randomness (lock 14
//      mirrored: learning never silently overrides policy).
//
//   3. AUDITABLE SETTLEMENT: `settleProviderUsage` routes through the
//      W009 authority gate (kind 'provider-settlement', level EXECUTE —
//      money movement is a consequential action), then claims the
//      window's UNSETTLED usage (settlement lines claim each usage
//      record exactly once — overlapping windows claim disjoint usage),
//      charges through the arrangement's wired settlement adapter with
//      the settlement id as the idempotency key (exactly-once charging),
//      and lands a guarded 'settled' transition carrying the receipt
//      reference, the normalized provider-neutral payload and a SHA-256
//      receipt digest that `getSettlementReceipt` RECOMPUTES on read
//      (tamper-evident audit). The charge lease lets a crashed
//      'settling' row be re-driven safely (the adapter key keeps the
//      charge exactly-once) — the W080 lease discipline applied to money
//      movement; `createSettlementWorkflowBindings` composes the same
//      core into durable, checkpointed workflow runs.
//
//   4. THE EXPLICIT FALLBACK: a 'direct-customer' arrangement refuses
//      settlement canonically (`settlement_direct_billing`, carrying the
//      registered external billing requirement) while usage recording,
//      attribution and budgets keep working — an unsupported
//      direct-billing provider never breaks the capability flow
//      (POST-S002 plan §25; handoff §4.9).
//
//   5. ADAPTER PLUGGABILITY: the domain speaks ONLY the canonical
//      ProviderSettlementAdapter port. The platform-account and
//      prepaid-balance adapters (adapters/) are wired at process start
//      through `wireSettlementAdapters`; nothing is wired by default —
//      settlement then fails explicitly with
//      `settlement_adapter_unavailable`. Every adapter failure is
//      normalized (W089 taxonomy) into a `settlement_adapter_failure`
//      carrying the canonical failure and recorded as append-only
//      settlement evidence — never a raw provider error, never a domain
//      fault, never a partial write.

import { now } from '@/infra/clock';
import { getDb, type DbRow, type Queryable } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import {
  authorizeAction,
  evaluateActionAuthority,
  ActionsError,
  type ActionRequest,
} from '@/modules/actions/contract';
import { listLlmExecutions } from '@/modules/llm/contract';
import { canonicalRequestDigest } from '@/modules/provider-sdk/contract';
import type { CanonicalProviderFailure } from '@/modules/provider-sdk/contract';
import type {
  WorkflowExecutorBindings,
  WorkflowStepInvocation,
  WorkflowStepResult,
} from '@/modules/workflow/contract';
import { WorkflowStepError } from '@/modules/workflow/contract';
import { SettlementAdapterError } from './adapters/shared';
import { ProviderBillingError } from './errors';
import {
  auditedBudgetIds,
  budgetCovers,
  budgetEventKind,
  budgetScopeKey,
  evaluateBudgetEnforcement,
  monthStartUtcIso,
} from './budget';
import {
  assertBillingTenantContext,
  isUuid,
  SETTLEMENT_LEASE_SECONDS,
  validateArrangementQuery,
  validateEnforceBudgetInput,
  validateImportLlmInput,
  validateListArrangementsQuery,
  validateListBudgetEventsQuery,
  validateListBudgetsQuery,
  validateListSettlementEventsQuery,
  validateListSettlementsQuery,
  validateListUsageQuery,
  validateRecordUsageInput,
  validateRegisterArrangementInput,
  validateRouteCandidates,
  validateSetBudgetInput,
  validateSettleInput,
  validateSettlementQuery,
  validateSettlementRunInput,
  validateUsageRecordQuery,
  validateUsageSummaryQuery,
} from './validation';
import type { ValidatedSettleInput } from './validation';
import type {
  BudgetEnforcement,
  ImportLlmUsageResult,
  PaymentArrangement,
  ProviderBudget,
  ProviderBudgetEvent,
  ProviderSettlement,
  ProviderSettlementAdapter,
  ProviderSettlementEvent,
  ProviderUsageRecord,
  RecordProviderUsageResult,
  RouteWithinBudgetResult,
  SettlementChargeResult,
  SettlementReceipt,
  SettlementReceiptLine,
  SettleProviderUsageResult,
  UsageSummary,
  UsageSummaryRow,
  WiredSettlementAdapterInfo,
} from './types';

// ---------------------------------------------------------------------------
// Authority vocabulary
// ---------------------------------------------------------------------------

/** The claim that administers arrangements and budgets (a management action). */
export const PROVIDER_BILLING_AUTHORITY_ADMINISTER = 'provider-billing:administer';

/** The W009 action kind every provider settlement passes through. */
export const PROVIDER_SETTLEMENT_ACTION_KIND = 'provider-settlement';

function requireAdminister(ctx: TenantContext): void {
  if (!ctx.authority.includes(PROVIDER_BILLING_AUTHORITY_ADMINISTER)) {
    throw new ProviderBillingError(
      'unauthorized',
      `managing payment arrangements and provider budgets requires the '${PROVIDER_BILLING_AUTHORITY_ADMINISTER}' authority claim`,
    );
  }
}

// ---------------------------------------------------------------------------
// Settlement adapter wiring (the pluggability seam)
// ---------------------------------------------------------------------------

let wiredAdapters: ProviderSettlementAdapter[] = [];

/** Wire the settlement adapter set (process-start wiring; null unwires everything). */
export function wireSettlementAdapters(adapters: ProviderSettlementAdapter[] | null): void {
  wiredAdapters = adapters === null ? [] : [...adapters];
}

/** The wired settlement adapters (read-only introspection/testing). */
export function getWiredSettlementAdapters(): ProviderSettlementAdapter[] {
  return [...wiredAdapters];
}

/** Read-only adapter introspection for surfaces/tests. */
export function listWiredSettlementAdapters(): WiredSettlementAdapterInfo[] {
  return wiredAdapters.map((adapter) => ({
    key: adapter.key,
    capabilities: [...adapter.definition.describeCapabilities().capabilities],
  }));
}

function adapterByKey(key: string): ProviderSettlementAdapter | null {
  return wiredAdapters.find((adapter) => adapter.key === key) ?? null;
}

// ---------------------------------------------------------------------------
// Rows and mappers
// ---------------------------------------------------------------------------

function toIso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function toIsoOrNull(value: Date | string | null): string | null {
  return value === null ? null : toIso(value);
}

interface ArrangementRow extends DbRow {
  id: string;
  tenant_id: string;
  gateway: string;
  provider: string;
  arrangement: string;
  settlement_adapter_key: string | null;
  direct_billing_note: string | null;
  status: string;
  created_by: string;
  created_at: Date | string;
  updated_at: Date | string;
}

function mapArrangement(row: ArrangementRow): PaymentArrangement {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    gateway: row.gateway,
    provider: row.provider,
    arrangement: row.arrangement as PaymentArrangement['arrangement'], // CHECK-constrained by migration 001
    settlementAdapterKey: row.settlement_adapter_key,
    directBillingNote: row.direct_billing_note,
    status: row.status as PaymentArrangement['status'], // CHECK-constrained
    createdBy: row.created_by,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

interface BudgetRow extends DbRow {
  id: string;
  tenant_id: string;
  scope: string;
  gateway: string | null;
  provider: string | null;
  capability: string | null;
  scope_key: string;
  budget_minor: number | typeof BigInt;
  currency: string;
  enforcement: string;
  status: string;
  note: string | null;
  created_by: string;
  created_at: Date | string;
  updated_at: Date | string;
}

function mapBudget(row: BudgetRow): ProviderBudget {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    scope: row.scope as ProviderBudget['scope'], // CHECK-constrained
    gateway: row.gateway,
    provider: row.provider,
    capability: row.capability,
    scopeKey: row.scope_key,
    budgetMinor: Number(row.budget_minor),
    currency: 'USD',
    enforcement: row.enforcement as ProviderBudget['enforcement'], // CHECK-constrained
    status: row.status as ProviderBudget['status'], // CHECK-constrained
    note: row.note,
    createdBy: row.created_by,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

interface UsageRow extends DbRow {
  id: string;
  tenant_id: string;
  gateway: string;
  provider: string;
  capability: string;
  execution_ref: string | null;
  account_ref: string | null;
  cost_minor: number | typeof BigInt;
  currency: string;
  quantity: number | typeof BigInt | null;
  unit: string | null;
  source: string;
  dedupe_key: string;
  occurred_at: Date | string;
  recorded_by: string;
  recorded_at: Date | string;
}

function mapUsage(row: UsageRow): ProviderUsageRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    gateway: row.gateway,
    provider: row.provider,
    capability: row.capability,
    executionRef: row.execution_ref,
    accountRef: row.account_ref,
    costMinor: Number(row.cost_minor),
    currency: 'USD',
    quantity: row.quantity === null ? null : Number(row.quantity),
    unit: row.unit,
    source: row.source,
    dedupeKey: row.dedupe_key,
    occurredAt: toIso(row.occurred_at),
    recordedBy: row.recorded_by,
    recordedAt: toIso(row.recorded_at),
  };
}

interface SettlementRow extends DbRow {
  id: string;
  tenant_id: string;
  gateway: string;
  provider: string;
  arrangement: string;
  settlement_adapter_key: string;
  window_from: Date | string;
  window_to: Date | string;
  status: string;
  line_count: number;
  amount_minor: number | typeof BigInt;
  currency: string;
  receipt_ref: string | null;
  receipt_payload: unknown;
  receipt_digest: string | null;
  action_request_id: string;
  failure: unknown;
  failure_detail: string | null;
  lease_expires_at: Date | string | null;
  settled_by: string | null;
  settled_at: Date | string | null;
  created_by: string;
  created_at: Date | string;
  updated_at: Date | string;
}

function asCanonicalFailure(value: unknown): CanonicalProviderFailure | null {
  if (value === null || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.category !== 'string' ||
    typeof record.retryable !== 'boolean' ||
    typeof record.recovery !== 'string' ||
    typeof record.healthImpact !== 'string' ||
    typeof record.gateway !== 'string' ||
    typeof record.provider !== 'string' ||
    typeof record.detail !== 'string'
  ) {
    return null;
  }
  return {
    category: record.category as CanonicalProviderFailure['category'],
    retryable: record.retryable,
    recovery: record.recovery as CanonicalProviderFailure['recovery'],
    healthImpact: record.healthImpact as CanonicalProviderFailure['healthImpact'],
    gateway: record.gateway,
    provider: record.provider,
    detail: record.detail,
    retryAfterMs: typeof record.retryAfterMs === 'number' ? record.retryAfterMs : null,
  };
}

function mapSettlement(row: SettlementRow): ProviderSettlement {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    gateway: row.gateway,
    provider: row.provider,
    arrangement: 'aurum-mediated',
    settlementAdapterKey: row.settlement_adapter_key,
    windowFrom: toIso(row.window_from),
    windowTo: toIso(row.window_to),
    status: row.status as ProviderSettlement['status'], // CHECK-constrained
    lineCount: Number(row.line_count),
    amountMinor: Number(row.amount_minor),
    currency: 'USD',
    receiptRef: row.receipt_ref,
    receiptPayload: row.receipt_payload ?? null,
    receiptDigest: row.receipt_digest,
    actionRequestId: row.action_request_id,
    failure: asCanonicalFailure(row.failure),
    failureDetail: row.failure_detail,
    leaseExpiresAt: toIsoOrNull(row.lease_expires_at),
    settledBy: row.settled_by,
    settledAt: toIsoOrNull(row.settled_at),
    createdBy: row.created_by,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

interface SettlementEventRow extends DbRow {
  id: string;
  tenant_id: string;
  settlement_id: string;
  seq: number;
  event: string;
  detail: string;
  occurred_at: Date | string;
}

function mapSettlementEvent(row: SettlementEventRow): ProviderSettlementEvent {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    settlementId: row.settlement_id,
    seq: Number(row.seq),
    event: row.event,
    detail: row.detail,
    occurredAt: toIso(row.occurred_at),
  };
}

interface LineStatsRow extends DbRow {
  capability: string;
  gateway: string;
  provider: string;
  records: number | typeof BigInt;
  cost_minor: number | typeof BigInt;
  quantity: number | typeof BigInt | null;
  executions: number | typeof BigInt;
}

interface UsageStatsRow extends DbRow {
  records: number | typeof BigInt;
  cost_minor: number | typeof BigInt;
  executions: number | typeof BigInt;
}

// ---------------------------------------------------------------------------
// Payment arrangements
// ---------------------------------------------------------------------------

/** Tenant-scoped arrangement lookup; uniform not-found (no cross-tenant leak). */
async function findArrangementRow(
  ctx: TenantContext,
  gateway: string,
  provider: string,
): Promise<ArrangementRow> {
  const rows = await getDb().query<ArrangementRow>(
    `SELECT * FROM provider_payment_arrangements WHERE tenant_id = $1 AND gateway = $2 AND provider = $3`,
    [ctx.tenantId, gateway, provider],
  );
  const row = rows.rows[0];
  if (row === undefined) {
    throw new ProviderBillingError(
      'arrangement_not_found',
      `no payment arrangement exists for '${gateway}/${provider}' in this tenant (register one through registerPaymentArrangement)`,
    );
  }
  return row;
}

export async function registerPaymentArrangement(
  ctx: TenantContext,
  input: unknown,
): Promise<PaymentArrangement> {
  const validCtx = assertBillingTenantContext(ctx);
  requireAdminister(ctx);
  const valid = validateRegisterArrangementInput(input);
  const at = now();
  const rows = await getDb().query<ArrangementRow>(
    `INSERT INTO provider_payment_arrangements
       (tenant_id, gateway, provider, arrangement, settlement_adapter_key,
        direct_billing_note, status, created_by, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'active', $7, $8, $8)
     ON CONFLICT (tenant_id, gateway, provider) DO UPDATE SET
       arrangement = EXCLUDED.arrangement,
       settlement_adapter_key = EXCLUDED.settlement_adapter_key,
       direct_billing_note = EXCLUDED.direct_billing_note,
       status = 'active',
       updated_at = EXCLUDED.updated_at
     RETURNING *`,
    [
      validCtx.tenantId,
      valid.gateway,
      valid.provider,
      valid.arrangement,
      valid.settlementAdapterKey,
      valid.directBillingNote,
      validCtx.principalId,
      at,
    ],
  );
  return mapArrangement(rows.rows[0]!);
}

export async function getPaymentArrangement(
  ctx: TenantContext,
  input: unknown,
): Promise<PaymentArrangement> {
  assertBillingTenantContext(ctx);
  const valid = validateArrangementQuery(input);
  const row = await findArrangementRow(ctx, valid.gateway, valid.provider);
  return mapArrangement(row);
}

export async function listPaymentArrangements(
  ctx: TenantContext,
  input: unknown,
): Promise<PaymentArrangement[]> {
  const validCtx = assertBillingTenantContext(ctx);
  const valid = validateListArrangementsQuery(input);
  const conditions: string[] = ['tenant_id = $1'];
  const params: unknown[] = [validCtx.tenantId];
  const add = (fragment: string, value: unknown): void => {
    params.push(value);
    conditions.push(fragment.replace('$#', `$${params.length}`));
  };
  if (valid.gateway !== null) add('gateway = $#', valid.gateway);
  if (valid.arrangement !== null) add('arrangement = $#', valid.arrangement);
  if (valid.status !== null) add('status = $#', valid.status);
  params.push(valid.limit);
  const rows = await getDb().query<ArrangementRow>(
    `SELECT * FROM provider_payment_arrangements WHERE ${conditions.join(' AND ')}
       ORDER BY created_at DESC, id DESC LIMIT $${params.length}`,
    params,
  );
  return rows.rows.map(mapArrangement);
}

// ---------------------------------------------------------------------------
// Usage ledger (cost attribution)
// ---------------------------------------------------------------------------

async function insertUsageRecord(
  ctx: TenantContext,
  valid: ReturnType<typeof validateRecordUsageInput>,
): Promise<{ record: ProviderUsageRecord; created: boolean }> {
  const at = now();
  const occurredAt = valid.occurredAt ?? at.toISOString();
  const inserted = await getDb().query<UsageRow>(
    `INSERT INTO provider_usage_records
       (tenant_id, gateway, provider, capability, execution_ref, account_ref,
        cost_minor, currency, quantity, unit, source, dedupe_key,
        occurred_at, recorded_by, recorded_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'USD', $8, $9, $10, $11, $12, $13, $14)
     ON CONFLICT (tenant_id, gateway, dedupe_key) DO NOTHING
     RETURNING *`,
    [
      ctx.tenantId,
      valid.gateway,
      valid.provider,
      valid.capability,
      valid.executionRef,
      valid.accountRef,
      valid.costMinor,
      valid.quantity,
      valid.unit,
      valid.source,
      valid.dedupeKey,
      occurredAt,
      ctx.principalId,
      at,
    ],
  );
  if (inserted.rows[0] !== undefined) {
    return { record: mapUsage(inserted.rows[0]), created: true };
  }
  // First write wins: replay the original record.
  const existing = await getDb().query<UsageRow>(
    `SELECT * FROM provider_usage_records WHERE tenant_id = $1 AND gateway = $2 AND dedupe_key = $3`,
    [ctx.tenantId, valid.gateway, valid.dedupeKey],
  );
  return { record: mapUsage(existing.rows[0]!), created: false };
}

export async function recordProviderUsage(
  ctx: TenantContext,
  input: unknown,
): Promise<RecordProviderUsageResult> {
  const validCtx = assertBillingTenantContext(ctx);
  const valid = validateRecordUsageInput(input);
  return insertUsageRecord({ ...ctx, tenantId: validCtx.tenantId, principalId: validCtx.principalId }, valid);
}

export async function getUsageRecord(
  ctx: TenantContext,
  input: unknown,
): Promise<ProviderUsageRecord> {
  const validCtx = assertBillingTenantContext(ctx);
  const valid = validateUsageRecordQuery(input);
  if (!isUuid(valid.usageId)) {
    throw new ProviderBillingError(
      'usage_not_found',
      `usage record '${valid.usageId}' does not exist in this tenant`,
    );
  }
  const rows = await getDb().query<UsageRow>(
    `SELECT * FROM provider_usage_records WHERE tenant_id = $1 AND id = $2`,
    [validCtx.tenantId, valid.usageId],
  );
  const row = rows.rows[0];
  if (row === undefined) {
    throw new ProviderBillingError(
      'usage_not_found',
      `usage record '${valid.usageId}' does not exist in this tenant`,
    );
  }
  return mapUsage(row);
}

export async function listUsageRecords(
  ctx: TenantContext,
  input: unknown,
): Promise<ProviderUsageRecord[]> {
  const validCtx = assertBillingTenantContext(ctx);
  const valid = validateListUsageQuery(input);
  const conditions: string[] = ['tenant_id = $1'];
  const params: unknown[] = [validCtx.tenantId];
  const add = (fragment: string, value: unknown): void => {
    params.push(value);
    conditions.push(fragment.replace('$#', `$${params.length}`));
  };
  if (valid.gateway !== null) add('gateway = $#', valid.gateway);
  if (valid.provider !== null) add('provider = $#', valid.provider);
  if (valid.capability !== null) add('capability = $#', valid.capability);
  if (valid.executionRef !== null) add('execution_ref = $#', valid.executionRef);
  if (valid.accountRef !== null) add('account_ref = $#', valid.accountRef);
  if (valid.since !== null) add('occurred_at >= $#', valid.since);
  if (valid.until !== null) add('occurred_at < $#', valid.until);
  params.push(valid.limit);
  const rows = await getDb().query<UsageRow>(
    `SELECT * FROM provider_usage_records WHERE ${conditions.join(' AND ')}
       ORDER BY occurred_at DESC, id DESC LIMIT $${params.length}`,
    params,
  );
  return rows.rows.map(mapUsage);
}

export async function getUsageSummary(
  ctx: TenantContext,
  input: unknown,
): Promise<UsageSummary> {
  const validCtx = assertBillingTenantContext(ctx);
  const valid = validateUsageSummaryQuery(input);
  const conditions: string[] = ['tenant_id = $1'];
  const params: unknown[] = [validCtx.tenantId];
  const add = (fragment: string, value: unknown): void => {
    params.push(value);
    conditions.push(fragment.replace('$#', `$${params.length}`));
  };
  if (valid.gateway !== null) add('gateway = $#', valid.gateway);
  if (valid.provider !== null) add('provider = $#', valid.provider);
  if (valid.capability !== null) add('capability = $#', valid.capability);
  if (valid.since !== null) add('occurred_at >= $#', valid.since);
  if (valid.until !== null) add('occurred_at < $#', valid.until);
  const where = conditions.join(' AND ');

  const totals = (
    await getDb().query<UsageStatsRow>(
      `SELECT COUNT(*)::integer AS records,
              COALESCE(SUM(cost_minor), 0)::bigint AS cost_minor,
              COUNT(DISTINCT execution_ref)::integer AS executions
         FROM provider_usage_records WHERE ${where}`,
      params,
    )
  ).rows[0]!;
  const groupRows = (
    await getDb().query<LineStatsRow>(
      `SELECT capability,
              gateway,
              provider,
              COUNT(*)::integer AS records,
              COALESCE(SUM(cost_minor), 0)::bigint AS cost_minor,
              COUNT(DISTINCT execution_ref)::integer AS executions,
              SUM(quantity)::bigint AS quantity
         FROM provider_usage_records WHERE ${where}
        GROUP BY gateway, provider, capability
        ORDER BY cost_minor DESC, gateway, provider, capability`,
      params,
    )
  ).rows;
  const rows: UsageSummaryRow[] = groupRows.map((row) => ({
    gateway: row.gateway as string,
    provider: row.provider as string,
    capability: row.capability,
    records: Number(row.records),
    costMinor: Number(row.cost_minor),
    quantity: row.quantity === null ? null : Number(row.quantity),
    executions: Number(row.executions),
  }));
  return {
    since: valid.since,
    until: valid.until,
    records: Number(totals.records),
    costMinor: Number(totals.cost_minor),
    executions: Number(totals.executions),
    rows,
  };
}

// ---------------------------------------------------------------------------
// Budget policy
// ---------------------------------------------------------------------------

export async function setProviderBudget(
  ctx: TenantContext,
  input: unknown,
): Promise<ProviderBudget> {
  const validCtx = assertBillingTenantContext(ctx);
  requireAdminister(ctx);
  const valid = validateSetBudgetInput(input);
  const at = now();
  const scopeKey = budgetScopeKey(valid.scope, valid.gateway, valid.provider, valid.capability);
  const rows = await getDb().query<BudgetRow>(
    `INSERT INTO provider_budgets
       (tenant_id, scope, gateway, provider, capability, scope_key,
        budget_minor, currency, enforcement, status, note, created_by,
        created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'USD', $8, 'active', $9, $10, $11, $11)
     ON CONFLICT (tenant_id, scope_key) DO UPDATE SET
       budget_minor = EXCLUDED.budget_minor,
       enforcement = EXCLUDED.enforcement,
       note = EXCLUDED.note,
       status = 'active',
       updated_at = EXCLUDED.updated_at
     RETURNING *`,
    [
      validCtx.tenantId,
      valid.scope,
      valid.gateway,
      valid.provider,
      valid.capability,
      scopeKey,
      valid.budgetMinor,
      valid.enforcement,
      valid.note,
      validCtx.principalId,
      at,
    ],
  );
  return mapBudget(rows.rows[0]!);
}

export async function retireProviderBudget(
  ctx: TenantContext,
  input: unknown,
): Promise<ProviderBudget> {
  const validCtx = assertBillingTenantContext(ctx);
  requireAdminister(ctx);
  const value = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
  if (!isUuid(value.budgetId)) {
    throw new ProviderBillingError('invalid_input', 'retireProviderBudget requires a budgetId uuid');
  }
  const rows = await getDb().query<BudgetRow>(
    `UPDATE provider_budgets SET status = 'retired', updated_at = $3
      WHERE tenant_id = $1 AND id = $2 AND status = 'active' RETURNING *`,
    [validCtx.tenantId, value.budgetId, now()],
  );
  const row = rows.rows[0];
  if (row === undefined) {
    throw new ProviderBillingError(
      'budget_not_found',
      `active budget '${value.budgetId}' does not exist in this tenant`,
    );
  }
  return mapBudget(row);
}

export async function listProviderBudgets(
  ctx: TenantContext,
  input: unknown,
): Promise<ProviderBudget[]> {
  const validCtx = assertBillingTenantContext(ctx);
  const valid = validateListBudgetsQuery(input);
  const conditions: string[] = ['tenant_id = $1'];
  const params: unknown[] = [validCtx.tenantId];
  const add = (fragment: string, value: unknown): void => {
    params.push(value);
    conditions.push(fragment.replace('$#', `$${params.length}`));
  };
  if (valid.status !== null) add('status = $#', valid.status);
  if (valid.gateway !== null) add('(gateway = $# OR gateway IS NULL)', valid.gateway);
  params.push(valid.limit);
  const rows = await getDb().query<BudgetRow>(
    `SELECT * FROM provider_budgets WHERE ${conditions.join(' AND ')}
       ORDER BY scope_key LIMIT $${params.length}`,
    params,
  );
  return rows.rows.map(mapBudget);
}

/** Load the month's usage grouped by (gateway, provider, capability) — the budget spend index. */
async function loadMonthlySpendGroups(
  tenantId: string,
  periodStart: string,
): Promise<Array<{ gateway: string; provider: string; capability: string; costMinor: number }>> {
  const rows = await getDb().query<{ gateway: string; provider: string; capability: string; cost: number | typeof BigInt }>(
    `SELECT gateway, provider, capability, COALESCE(SUM(cost_minor), 0)::bigint AS cost
       FROM provider_usage_records
      WHERE tenant_id = $1 AND occurred_at >= $2
      GROUP BY gateway, provider, capability`,
    [tenantId, periodStart],
  );
  return rows.rows.map((row) => ({
    gateway: row.gateway,
    provider: row.provider,
    capability: row.capability,
    costMinor: Number(row.cost),
  }));
}

function spendForScope(
  budget: Pick<ProviderBudget, 'scope' | 'gateway' | 'provider' | 'capability'>,
  groups: ReadonlyArray<{ gateway: string; provider: string; capability: string; costMinor: number }>,
): number {
  return groups
    .filter((group) => budgetCovers(budget, group.gateway, group.provider, group.capability))
    .reduce((sum, group) => sum + group.costMinor, 0);
}

async function evaluateBudget(
  ctx: TenantContext,
  request: ReturnType<typeof validateEnforceBudgetInput>,
): Promise<BudgetEnforcement> {
  const periodStart = monthStartUtcIso(now());
  const budgets = (
    await getDb().query<BudgetRow>(
      `SELECT * FROM provider_budgets WHERE tenant_id = $1 AND status = 'active'`,
      [ctx.tenantId],
    )
  ).rows.map(mapBudget);
  const covering = budgets.filter((budget) =>
    budgetCovers(budget, request.gateway, request.provider, request.capability),
  );
  const groups = await loadMonthlySpendGroups(ctx.tenantId, periodStart);
  const spendMinorByBudget = new Map<string, number>();
  for (const budget of covering) {
    spendMinorByBudget.set(budget.id, spendForScope(budget, groups));
  }
  return evaluateBudgetEnforcement(
    { covering, spendMinorByBudget, periodStart },
    {
      gateway: request.gateway,
      provider: request.provider,
      capability: request.capability,
      projectedCostMinor: request.projectedCostMinor,
    },
  );
}

export async function enforceProviderBudget(
  ctx: TenantContext,
  input: unknown,
): Promise<BudgetEnforcement> {
  const validCtx = assertBillingTenantContext(ctx);
  const valid = validateEnforceBudgetInput(input);
  const scoped = { ...ctx, tenantId: validCtx.tenantId, principalId: validCtx.principalId };
  const enforcement = await evaluateBudget(scoped, valid);

  // Append-only evidence for the outcomes that bit (blocks and observed
  // exceedance) — the trace of a usage that never ran, and of the policy
  // posture when usage ran anyway.
  const kind = budgetEventKind(enforcement);
  if (kind !== null) {
    for (const budgetId of auditedBudgetIds(enforcement)) {
      const posture = enforcement.postures.find((p) => p.budgetId === budgetId);
      if (posture === undefined) continue;
      await getDb().query(
        `INSERT INTO provider_budget_events
           (tenant_id, budget_id, scope_key, event, detail, enforcement, checked_by, occurred_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)`,
        [
          scoped.tenantId,
          budgetId,
          posture.scopeKey,
          kind,
          enforcement.reason ?? `observed exceedance of the '${posture.scopeKey || 'tenant-wide'}' budget`,
          JSON.stringify(enforcement),
          scoped.principalId,
          now(),
        ],
      );
    }
  }
  return enforcement;
}

export async function routeWithinBudget(
  ctx: TenantContext,
  input: unknown,
): Promise<RouteWithinBudgetResult> {
  const validCtx = assertBillingTenantContext(ctx);
  const wrapper =
    typeof input === 'object' && input !== null && !Array.isArray(input) && 'candidates' in input
      ? (input as { candidates: unknown }).candidates
      : input;
  const candidates = validateRouteCandidates(wrapper);
  const scoped = { ...ctx, tenantId: validCtx.tenantId, principalId: validCtx.principalId };
  const routed: RouteWithinBudgetResult['routed'] = [];
  const blocked: RouteWithinBudgetResult['blocked'] = [];
  for (const candidate of candidates) {
    const enforcement = await evaluateBudget(scoped, candidate);
    if (enforcement.decision === 'block') {
      blocked.push({ ...candidate, reason: enforcement.reason ?? 'budget policy blocks this target' });
    } else {
      routed.push(candidate);
    }
  }
  return { routed, blocked };
}

export async function listBudgetEvents(
  ctx: TenantContext,
  input: unknown,
): Promise<ProviderBudgetEvent[]> {
  const validCtx = assertBillingTenantContext(ctx);
  const valid = validateListBudgetEventsQuery(input);
  const conditions: string[] = ['tenant_id = $1'];
  const params: unknown[] = [validCtx.tenantId];
  const add = (fragment: string, value: unknown): void => {
    params.push(value);
    conditions.push(fragment.replace('$#', `$${params.length}`));
  };
  if (valid.budgetId !== null) add('budget_id = $#', valid.budgetId);
  if (valid.event !== null) add('event = $#', valid.event);
  params.push(valid.limit);
  const rows = await getDb().query<
    DbRow & {
      id: string;
      tenant_id: string;
      budget_id: string;
      scope_key: string;
      event: string;
      detail: string;
      enforcement: unknown;
      checked_by: string;
      occurred_at: Date | string;
    }
  >(
    `SELECT * FROM provider_budget_events WHERE ${conditions.join(' AND ')}
       ORDER BY occurred_at DESC, id DESC LIMIT $${params.length}`,
    params,
  );
  return rows.rows.map((row) => ({
    id: row.id,
    tenantId: row.tenant_id,
    budgetId: row.budget_id,
    scopeKey: row.scope_key,
    event: row.event,
    detail: row.detail,
    enforcement: row.enforcement as BudgetEnforcement,
    checkedBy: row.checked_by,
    occurredAt: toIso(row.occurred_at),
  }));
}

// ---------------------------------------------------------------------------
// Settlement — the W009 authority gate
// ---------------------------------------------------------------------------

async function authorizeSettlement(
  ctx: TenantContext,
  descriptor: Record<string, unknown>,
  idempotencyKey: string | null,
): Promise<string> {
  let request: ActionRequest;
  try {
    request = await authorizeAction(ctx, {
      actionKind: PROVIDER_SETTLEMENT_ACTION_KIND,
      authorityLevel: 'EXECUTE',
      payload: descriptor,
      idempotencyKey: idempotencyKey ?? `settle:${newId()}`,
    });
  } catch (error) {
    if (error instanceof ActionsError) {
      if (error.code === 'invalid_context') {
        throw new ProviderBillingError('invalid_context', error.message);
      }
      if (error.code === 'invalid_action_input') {
        throw new ProviderBillingError('invalid_input', error.message);
      }
      throw new Error(
        `the authority gate rejected a pre-validated settlement (internal invariant violation): ${error.message}`,
        { cause: error },
      );
    }
    throw error;
  }
  if (request.status === 'rejected') {
    throw new ProviderBillingError(
      'settlement_forbidden',
      `the tenant authority policy forbids EXECUTE of '${PROVIDER_SETTLEMENT_ACTION_KIND}' (request '${request.id}'; decided via ${request.evaluation.resolvedVia})`,
    );
  }
  if (request.status === 'pending') {
    throw new ProviderBillingError(
      'settlement_approval_required',
      `action request '${request.id}' (kind '${PROVIDER_SETTLEMENT_ACTION_KIND}', level EXECUTE) awaits a human approval decision — approve it through the actions module, then retry with the same idempotencyKey`,
      null,
      request.id,
    );
  }
  return request.id;
}

// ---------------------------------------------------------------------------
// Settlement — the durable core (claim → charge → guarded transitions)
// ---------------------------------------------------------------------------

interface WindowClaim {
  kind: 'settled' | 'in_flight' | 'nothing' | 'claimed' | 'redrive';
  row: SettlementRow;
}

const SETTLEMENT_WINDOW_COLUMNS = `id, tenant_id, gateway, provider, arrangement,
  settlement_adapter_key, window_from, window_to, status, line_count,
  amount_minor, currency, receipt_ref, receipt_payload, receipt_digest,
  action_request_id, failure, failure_detail, lease_expires_at, settled_by,
  settled_at, created_by, created_at, updated_at`;

function settlementWhere(): string {
  return `tenant_id = $1 AND gateway = $2 AND provider = $3 AND window_from = $4 AND window_to = $5`;
}

/**
 * Claim (or re-drive) one settlement window. The transaction locks the
 * window key, picks the window's UNSETTLED usage (FOR UPDATE — the line
 * UNIQUE claim makes usage settle exactly once, ever), and inserts the
 * settlement row in 'settling' with a fresh charge lease. Re-drives
 * (failed rows, expired leases) reuse the SAME row so the adapter's
 * idempotency key keeps the charge exactly-once.
 */
async function claimSettlementWindow(
  ctx: TenantContext,
  tx: Queryable,
  window: { gateway: string; provider: string; windowFrom: string; windowTo: string },
  arrangement: ArrangementRow,
  actionRequestId: string,
  at: Date,
): Promise<WindowClaim> {
  const params = [ctx.tenantId, window.gateway, window.provider, window.windowFrom, window.windowTo];
  const existing = (
    await tx.query<SettlementRow>(
      `SELECT ${SETTLEMENT_WINDOW_COLUMNS} FROM provider_settlements
        WHERE ${settlementWhere()} FOR UPDATE`,
      params,
    )
  ).rows[0];
  if (existing !== undefined) {
    if (existing.status === 'settled') return { kind: 'settled', row: existing };
    if (
      existing.status === 'settling' &&
      existing.lease_expires_at !== null &&
      new Date(existing.lease_expires_at).getTime() > at.getTime()
    ) {
      return { kind: 'in_flight', row: existing };
    }
    // 'failed', or a 'settling' row past its lease: re-drive the SAME row.
    const redriven = (
      await tx.query<SettlementRow>(
        `UPDATE provider_settlements
           SET status = 'settling', lease_expires_at = $3, failure = NULL,
               failure_detail = NULL, updated_at = $4
         WHERE tenant_id = $1 AND id = $2 AND status IN ('failed', 'settling')
         RETURNING ${SETTLEMENT_WINDOW_COLUMNS}`,
        [ctx.tenantId, existing.id, new Date(at.getTime() + SETTLEMENT_LEASE_SECONDS * 1000), at],
      )
    ).rows[0]!;
    return { kind: 'redrive', row: redriven };
  }

  // The window's unsettled usage, locked against concurrent claims: the
  // anti-join re-evaluates after any blocker commits, and the line
  // UNIQUE(usage_record_id) is the storage-level backstop.
  const usage = (
    await tx.query<UsageRow>(
      `SELECT u.* FROM provider_usage_records u
        WHERE u.tenant_id = $1 AND u.gateway = $2 AND u.provider = $3
          AND u.occurred_at >= $4 AND u.occurred_at < $5
          AND NOT EXISTS (
            SELECT 1 FROM provider_settlement_lines l WHERE l.usage_record_id = u.id
          )
        ORDER BY u.occurred_at ASC, u.id ASC
        FOR UPDATE OF u`,
      params,
    )
  ).rows;
  if (usage.length === 0) {
    // A concurrent settlement may have claimed and committed while we
    // waited on its usage locks — re-read the window key before refusing.
    const raced = (
      await tx.query<SettlementRow>(
        `SELECT ${SETTLEMENT_WINDOW_COLUMNS} FROM provider_settlements WHERE ${settlementWhere()}`,
        params,
      )
    ).rows[0];
    if (raced !== undefined) return { kind: raced.status === 'settled' ? 'settled' : 'in_flight', row: raced };
    throw new ProviderBillingError(
      'settlement_nothing_to_settle',
      `no unsettled usage exists for '${window.gateway}/${window.provider}' inside [${window.windowFrom}, ${window.windowTo})`,
    );
  }

  const settlementId = newId();
  const amountMinor = usage.reduce((sum, row) => sum + Number(row.cost_minor), 0);
  const leaseExpiresAt = new Date(at.getTime() + SETTLEMENT_LEASE_SECONDS * 1000);
  const inserted = (
    await tx.query<SettlementRow>(
      `INSERT INTO provider_settlements
         (id, tenant_id, gateway, provider, arrangement, settlement_adapter_key,
          window_from, window_to, status, line_count, amount_minor, currency,
          action_request_id, lease_expires_at, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'aurum-mediated', $5, $6, $7, 'settling', $8, $9, 'USD',
               $10, $11, $12, $13, $13)
       RETURNING ${SETTLEMENT_WINDOW_COLUMNS}`,
      [
        settlementId,
        ctx.tenantId,
        window.gateway,
        window.provider,
        arrangement.settlement_adapter_key,
        window.windowFrom,
        window.windowTo,
        usage.length,
        amountMinor,
        actionRequestId,
        leaseExpiresAt,
        ctx.principalId,
        at,
      ],
    )
  ).rows[0]!;
  for (const row of usage) {
    await tx.query(
      `INSERT INTO provider_settlement_lines
         (tenant_id, settlement_id, usage_record_id, gateway, provider,
          capability, execution_ref, cost_minor, currency, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'USD', $9)`,
      [
        ctx.tenantId,
        settlementId,
        row.id,
        row.gateway,
        row.provider,
        row.capability,
        row.execution_ref,
        Number(row.cost_minor),
        row.occurred_at,
      ],
    );
  }
  await tx.query(
    `INSERT INTO provider_settlement_events
       (tenant_id, settlement_id, event, detail, occurred_at)
     VALUES ($1, $2, 'window_claimed', $3, $4)`,
    [
      ctx.tenantId,
      settlementId,
      `claimed ${usage.length} usage record(s) totalling ${amountMinor} minor for [${window.windowFrom}, ${window.windowTo})`,
      at,
    ],
  );
  return { kind: 'claimed', row: inserted };
}

/** Build the receipt line stats of one settlement from its lines. */
async function loadReceiptLines(
  tenantId: string,
  settlementId: string,
): Promise<SettlementReceiptLine[]> {
  const rows = await getDb().query<LineStatsRow>(
    `SELECT capability,
              COUNT(*)::integer AS records,
              COALESCE(SUM(cost_minor), 0)::bigint AS cost_minor,
              COUNT(DISTINCT execution_ref)::integer AS executions
       FROM provider_settlement_lines
      WHERE tenant_id = $1 AND settlement_id = $2
      GROUP BY capability
      ORDER BY cost_minor DESC, capability`,
    [tenantId, settlementId],
  );
  return rows.rows.map((row) => ({
    capability: row.capability,
    records: Number(row.records),
    costMinor: Number(row.cost_minor),
    executions: Number(row.executions),
  }));
}

async function loadReceiptTotals(
  tenantId: string,
  settlementId: string,
): Promise<{ records: number; executions: number }> {
  const row = (
    await getDb().query<UsageStatsRow>(
      `SELECT COUNT(*)::integer AS records,
              COUNT(DISTINCT execution_ref)::integer AS executions
         FROM provider_settlement_lines
        WHERE tenant_id = $1 AND settlement_id = $2`,
      [tenantId, settlementId],
    )
  ).rows[0]!;
  return { records: Number(row.records), executions: Number(row.executions) };
}

/** The canonical receipt content the digest covers (stable serialization via the W089 SDK). */
function receiptDigestInput(
  settlement: ProviderSettlement,
  receipt: Omit<SettlementReceipt, 'receiptDigest'>,
): unknown {
  return {
    settlementId: settlement.id,
    tenantId: settlement.tenantId,
    gateway: settlement.gateway,
    provider: settlement.provider,
    arrangement: settlement.arrangement,
    settlementAdapterKey: settlement.settlementAdapterKey,
    windowFrom: settlement.windowFrom,
    windowTo: settlement.windowTo,
    lineCount: settlement.lineCount,
    amountMinor: settlement.amountMinor,
    currency: settlement.currency,
    receiptRef: receipt.receiptRef,
    receiptPayload: receipt.receiptPayload,
    actionRequestId: receipt.actionRequestId,
    settledBy: receipt.settledBy,
    settledAt: receipt.settledAt,
    usage: receipt.usage,
  };
}

async function buildReceipt(
  row: SettlementRow,
  lines: SettlementReceiptLine[],
  totals: { records: number; executions: number },
): Promise<SettlementReceipt> {
  const settlement = mapSettlement(row);
  const receipt: Omit<SettlementReceipt, 'receiptDigest'> = {
    settlementId: settlement.id,
    tenantId: settlement.tenantId,
    gateway: settlement.gateway,
    provider: settlement.provider,
    arrangement: 'aurum-mediated',
    settlementAdapterKey: settlement.settlementAdapterKey,
    windowFrom: settlement.windowFrom,
    windowTo: settlement.windowTo,
    status: settlement.status,
    lineCount: settlement.lineCount,
    amountMinor: settlement.amountMinor,
    currency: settlement.currency,
    usage: {
      records: totals.records,
      executions: totals.executions,
      byCapability: lines,
    },
    receiptRef: settlement.receiptRef,
    receiptPayload: settlement.receiptPayload,
    actionRequestId: settlement.actionRequestId,
    settledBy: settlement.settledBy,
    settledAt: settlement.settledAt,
    failure: settlement.failure,
  };
  const digest = canonicalRequestDigest(receiptDigestInput(settlement, receipt));
  return { ...receipt, receiptDigest: digest };
}

/**
 * The settlement core shared by the public (authority-gated) path and the
 * durable workflow bridge (approval released by the workflow engine's
 * wait): resolve the arrangement, claim the window, charge through the
 * wired adapter exactly-once, land the guarded transition.
 */
async function settleWindowInternal(
  ctx: TenantContext,
  window: { gateway: string; provider: string; windowFrom: string; windowTo: string },
  actionRequestId: string,
): Promise<SettleProviderUsageResult> {
  const arrangementRow = await findArrangementRow(ctx, window.gateway, window.provider);
  const arrangement = mapArrangement(arrangementRow);
  if (arrangement.status !== 'active') {
    throw new ProviderBillingError(
      'arrangement_retired',
      `the payment arrangement for '${window.gateway}/${window.provider}' is retired (settlement requires an active arrangement)`,
    );
  }
  if (arrangement.arrangement !== 'aurum-mediated') {
    throw new ProviderBillingError(
      'settlement_direct_billing',
      `the provider '${window.provider}' bills this customer directly (Aurum-mediated settlement is unavailable): ${arrangement.directBillingNote ?? 'the provider requires a direct billing relationship'} — usage attribution and budgets continue to work`,
    );
  }
  const adapter = adapterByKey(arrangement.settlementAdapterKey ?? '');
  if (adapter === null) {
    throw new ProviderBillingError(
      'settlement_adapter_unavailable',
      `no '${arrangement.settlementAdapterKey}' settlement adapter is wired (wire one via wireSettlementAdapters)`,
    );
  }

  const at = now();
  const claim = await getDb().transaction(async (tx) =>
    claimSettlementWindow(ctx, tx, window, arrangementRow, actionRequestId, at),
  );
  if (claim.kind === 'settled') {
    const [lines, totals] = await Promise.all([
      loadReceiptLines(ctx.tenantId, claim.row.id),
      loadReceiptTotals(ctx.tenantId, claim.row.id),
    ]);
    return { settlement: mapSettlement(claim.row), receipt: await buildReceipt(claim.row, lines, totals) };
  }
  if (claim.kind === 'in_flight') {
    throw new ProviderBillingError(
      'settlement_in_flight',
      `settlement '${claim.row.id}' of [${window.windowFrom}, ${window.windowTo}) is charging under another holder (lease until ${toIso(claim.row.lease_expires_at!)}) — retry after the lease expires; the adapter idempotency key keeps the charge exactly-once`,
    );
  }
  if (claim.kind === 'nothing') {
    throw new ProviderBillingError(
      'settlement_nothing_to_settle',
      `no unsettled usage exists for '${window.gateway}/${window.provider}' inside [${window.windowFrom}, ${window.windowTo})`,
    );
  }
  const settlement = claim.row;

  // Charge through the adapter — the settlement id IS the idempotency key.
  let charge: SettlementChargeResult;
  try {
    charge = await adapter.charge({
      settlementId: settlement.id,
      tenantId: ctx.tenantId,
      gateway: window.gateway,
      provider: window.provider,
      amountMinor: Number(settlement.amount_minor),
      currency: 'USD',
      idempotencyKey: settlement.id,
      description: `Aurum provider settlement ${window.gateway}/${window.provider} [${window.windowFrom} .. ${window.windowTo})`,
      occurredAt: at.toISOString(),
    });
  } catch (error) {
    const failure: CanonicalProviderFailure =
      error instanceof SettlementAdapterError
        ? error.failure
        : adapter.definition.mapError(error);
    await getDb().query(
      `UPDATE provider_settlements
         SET status = 'failed', failure = $3::jsonb, failure_detail = $4,
             lease_expires_at = NULL, updated_at = $5
       WHERE tenant_id = $1 AND id = $2 AND status = 'settling'`,
      [ctx.tenantId, settlement.id, JSON.stringify(failure), failure.detail, now()],
    );
    await getDb().query(
      `INSERT INTO provider_settlement_events
         (tenant_id, settlement_id, event, detail, occurred_at)
       VALUES ($1, $2, 'charge_failed', $3, $4)`,
      [
        ctx.tenantId,
        settlement.id,
        `charge failed (${failure.category}): ${failure.detail}`,
        now(),
      ],
    );
    throw new ProviderBillingError(
      'settlement_adapter_failure',
      `the ${settlement.settlement_adapter_key} settlement adapter failed to charge settlement '${settlement.id}' (${failure.category}): ${failure.detail}`,
      failure,
    );
  }

  // The receipt's canonical content: the committed lines' attribution
  // stats plus the charge result — loaded BEFORE the guarded transition so
  // the digest stored at settle time is exactly what reads recompute.
  const [lines, totals] = await Promise.all([
    loadReceiptLines(ctx.tenantId, settlement.id),
    loadReceiptTotals(ctx.tenantId, settlement.id),
  ]);
  const settledAt = now();
  const provisionalRow: SettlementRow = {
    ...settlement,
    status: 'settled',
    receipt_ref: charge.receiptRef,
    receipt_payload:
      charge.receiptPayload !== null && typeof charge.receiptPayload === 'object'
        ? charge.receiptPayload
        : {},
    receipt_digest: null,
    lease_expires_at: null,
    settled_by: ctx.principalId,
    settled_at: settledAt,
  };
  const receipt = await buildReceipt(provisionalRow, lines, totals);
  const settledRow = (
    await getDb().query<SettlementRow>(
      `UPDATE provider_settlements
         SET status = 'settled', receipt_ref = $3, receipt_payload = $4::jsonb,
             receipt_digest = $5, lease_expires_at = NULL, settled_by = $6,
             settled_at = $7, updated_at = $7
       WHERE tenant_id = $1 AND id = $2 AND status = 'settling'
       RETURNING ${SETTLEMENT_WINDOW_COLUMNS}`,
      [
        ctx.tenantId,
        settlement.id,
        charge.receiptRef,
        JSON.stringify(
          charge.receiptPayload !== null && typeof charge.receiptPayload === 'object'
            ? charge.receiptPayload
            : {},
        ),
        receipt.receiptDigest,
        ctx.principalId,
        settledAt,
      ],
    )
  ).rows[0];
  await getDb().query(
    `INSERT INTO provider_settlement_events
       (tenant_id, settlement_id, event, detail, occurred_at)
     VALUES ($1, $2, 'charge_succeeded', $3, $4)`,
    [
      ctx.tenantId,
      settlement.id,
      `charged ${Number(settlement.amount_minor)} minor through '${settlement.settlement_adapter_key}' (receipt '${charge.receiptRef}')`,
      settledAt,
    ],
  );
  if (settledRow === undefined) {
    // The guarded UPDATE lost a race (a concurrent re-drive finalized the
    // row first) — read the authoritative state back.
    const current = (
      await getDb().query<SettlementRow>(
        `SELECT ${SETTLEMENT_WINDOW_COLUMNS} FROM provider_settlements WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, settlement.id],
      )
    ).rows[0]!;
    const [linesNow, totalsNow] = await Promise.all([
      loadReceiptLines(ctx.tenantId, current.id),
      loadReceiptTotals(ctx.tenantId, current.id),
    ]);
    return {
      settlement: mapSettlement(current),
      receipt: await buildReceipt(current, linesNow, totalsNow),
    };
  }
  return { settlement: mapSettlement(settledRow), receipt };
}

export async function settleProviderUsage(
  ctx: TenantContext,
  input: unknown,
): Promise<SettleProviderUsageResult> {
  const validCtx = assertBillingTenantContext(ctx);
  const valid: ValidatedSettleInput = validateSettleInput(input);
  const scoped = { ...ctx, tenantId: validCtx.tenantId, principalId: validCtx.principalId };
  const actionRequestId = await authorizeSettlement(
    scoped,
    {
      gateway: valid.gateway,
      provider: valid.provider,
      windowFrom: valid.windowFrom,
      windowTo: valid.windowTo,
    },
    valid.idempotencyKey,
  );
  return settleWindowInternal(
    scoped,
    {
      gateway: valid.gateway,
      provider: valid.provider,
      windowFrom: valid.windowFrom,
      windowTo: valid.windowTo,
    },
    actionRequestId,
  );
}

// ---------------------------------------------------------------------------
// Settlement reads (the audit surface)
// ---------------------------------------------------------------------------

async function findSettlementRow(ctx: TenantContext, settlementId: string): Promise<SettlementRow> {
  if (!isUuid(settlementId)) {
    throw new ProviderBillingError(
      'settlement_not_found',
      `settlement '${settlementId}' does not exist in this tenant`,
    );
  }
  const rows = await getDb().query<SettlementRow>(
    `SELECT ${SETTLEMENT_WINDOW_COLUMNS} FROM provider_settlements WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, settlementId],
  );
  const row = rows.rows[0];
  if (row === undefined) {
    throw new ProviderBillingError(
      'settlement_not_found',
      `settlement '${settlementId}' does not exist in this tenant`,
    );
  }
  return row;
}

export async function getSettlement(
  ctx: TenantContext,
  input: unknown,
): Promise<ProviderSettlement> {
  const validCtx = assertBillingTenantContext(ctx);
  const valid = validateSettlementQuery(input);
  const row = await findSettlementRow({ ...ctx, tenantId: validCtx.tenantId }, valid.settlementId);
  return mapSettlement(row);
}

export async function listSettlements(
  ctx: TenantContext,
  input: unknown,
): Promise<ProviderSettlement[]> {
  const validCtx = assertBillingTenantContext(ctx);
  const valid = validateListSettlementsQuery(input);
  const conditions: string[] = ['tenant_id = $1'];
  const params: unknown[] = [validCtx.tenantId];
  const add = (fragment: string, value: unknown): void => {
    params.push(value);
    conditions.push(fragment.replace('$#', `$${params.length}`));
  };
  if (valid.gateway !== null) add('gateway = $#', valid.gateway);
  if (valid.provider !== null) add('provider = $#', valid.provider);
  if (valid.status !== null) add('status = $#', valid.status);
  params.push(valid.limit);
  const rows = await getDb().query<SettlementRow>(
    `SELECT ${SETTLEMENT_WINDOW_COLUMNS} FROM provider_settlements WHERE ${conditions.join(' AND ')}
       ORDER BY created_at DESC, id DESC LIMIT $${params.length}`,
    params,
  );
  return rows.rows.map(mapSettlement);
}

export async function getSettlementReceipt(
  ctx: TenantContext,
  input: unknown,
): Promise<SettlementReceipt> {
  const validCtx = assertBillingTenantContext(ctx);
  const valid = validateSettlementQuery(input);
  const scoped = { ...ctx, tenantId: validCtx.tenantId };
  const row = await findSettlementRow(scoped, valid.settlementId);
  const [lines, totals] = await Promise.all([
    loadReceiptLines(scoped.tenantId, row.id),
    loadReceiptTotals(scoped.tenantId, row.id),
  ]);
  const receipt = await buildReceipt(row, lines, totals);
  if (receipt.status === 'settled' && receipt.receiptDigest !== row.receipt_digest) {
    // Tamper-evidence: the stored digest no longer matches the recomputed
    // canonical content of the settlement + its lines.
    throw new ProviderBillingError(
      'settlement_invalid_state',
      `the stored receipt digest of settlement '${row.id}' does not match its recomputed content (ledger integrity break)`,
    );
  }
  return receipt;
}

export async function listSettlementEvents(
  ctx: TenantContext,
  input: unknown,
): Promise<ProviderSettlementEvent[]> {
  const validCtx = assertBillingTenantContext(ctx);
  const valid = validateListSettlementEventsQuery(input);
  const scoped = { ...ctx, tenantId: validCtx.tenantId };
  // The settlement must be readable in THIS tenant (uniform not-found).
  await findSettlementRow(scoped, valid.settlementId);
  const rows = await getDb().query<SettlementEventRow>(
    `SELECT * FROM provider_settlement_events
      WHERE tenant_id = $1 AND settlement_id = $2
      ORDER BY seq ASC LIMIT $3`,
    [scoped.tenantId, valid.settlementId, valid.limit],
  );
  return rows.rows.map(mapSettlementEvent);
}

// ---------------------------------------------------------------------------
// The W034 composition bridge — llm gateway usage into the billing ledger
// ---------------------------------------------------------------------------

export async function importLlmUsage(
  ctx: TenantContext,
  input: unknown,
): Promise<ImportLlmUsageResult> {
  const validCtx = assertBillingTenantContext(ctx);
  const valid = validateImportLlmInput(input);
  const scoped = { ...ctx, tenantId: validCtx.tenantId, principalId: validCtx.principalId };
  const executions = await listLlmExecutions(scoped, { status: 'completed', limit: valid.limit });
  let imported = 0;
  let skipped = 0;
  for (const execution of executions) {
    const result = await insertUsageRecord(scoped, {
      gateway: 'llm',
      provider: execution.provider,
      capability: execution.capability,
      executionRef: execution.id,
      accountRef: execution.accountId,
      costMinor: execution.costMinor,
      quantity: execution.inputTokens + execution.outputTokens,
      unit: 'tokens',
      source: 'llm-import',
      dedupeKey: `llm-execution:${execution.id}`,
      occurredAt: execution.invokedAt,
    });
    if (result.created) imported += 1;
    else skipped += 1;
  }
  return { imported, skipped, considered: executions.length };
}

// ---------------------------------------------------------------------------
// The W080 composition bridge — durable settlement workflow runs
// ---------------------------------------------------------------------------

/**
 * Executor bindings for the canonical settlement workflow
 * (`provider-billing.settlement`): ONE step settles the run's windows one
 * per invocation (bounded unit of work), checkpointing durable progress
 * — a crashed worker's run resumes from the next window with the
 * authorizing action request preserved in the checkpoint.
 *
 * The authority gate rides the workflow engine's own approval wait: the
 * fresh invocation evaluates the matrix read-only (failing fast when
 * settlement is forbidden), then proposes the approval; the engine routes
 * the proposal through `authorizeAction` under the run's ORIGINAL durable
 * context (no forked W009 semantics), and only a released approval
 * settles — the same kind/level the public `settleProviderUsage` path
 * uses, recorded by the actions module, replayed by workflow recovery.
 */
export function createSettlementWorkflowBindings(ctx: TenantContext): WorkflowExecutorBindings {
  return {
    'provider-billing.settlement': {
      'settle-windows': async (invocation: WorkflowStepInvocation): Promise<WorkflowStepResult> => {
        const input = validateSettlementRunInput(invocation.input);

        // Fresh invocation: fail fast on a forbidding policy, then propose
        // the approval wait (auto-approving policy resolves on the next pump).
        if (invocation.checkpoint === null && invocation.wait === null) {
          const evaluation = await evaluateActionAuthority(ctx, {
            actionKind: PROVIDER_SETTLEMENT_ACTION_KIND,
            authorityLevel: 'EXECUTE',
          });
          if (evaluation.outcome === 'forbidden') {
            // DETERMINISTIC: a forbidden policy is a rejection retrying
            // cannot change — dead-letter the run immediately.
            throw new WorkflowStepError(
              'settlement_forbidden',
              `the tenant authority policy forbids EXECUTE of '${PROVIDER_SETTLEMENT_ACTION_KIND}' (decided via ${evaluation.resolvedVia}) — the settlement run cannot proceed`,
            );
          }
          return {
            type: 'wait',
            wait: {
              kind: 'approval',
              approval: {
                actionKind: PROVIDER_SETTLEMENT_ACTION_KIND,
                authorityLevel: 'EXECUTE',
                payload: { windows: input.windows },
                justification: `settle ${input.windows.length} provider usage window(s) through the Aurum provider billing gateway`,
              },
            },
          };
        }

        // Approval released (or checkpointed continuation): settle.
        if (
          invocation.wait !== null &&
          invocation.wait.kind === 'approval' &&
          invocation.wait.decision === 'rejected'
        ) {
          // DETERMINISTIC: a rejected approval is a human decision —
          // retrying the step cannot un-reject it.
          throw new WorkflowStepError(
            'settlement_approval_rejected',
            'the settlement approval was rejected — the settlement run cannot proceed',
          );
        }
        const checkpointShape =
          invocation.checkpoint === null
            ? { settled: [] as string[], skipped: 0, nextIndex: 0, actionRequestId: null as string | null }
            : (invocation.checkpoint as {
                settled: string[];
                skipped: number;
                nextIndex: number;
                actionRequestId: string | null;
              });
        const actionRequestId =
          checkpointShape.actionRequestId ??
          (invocation.wait !== null && invocation.wait.kind === 'approval'
            ? invocation.wait.requestId
            : null);
        if (actionRequestId === null) {
          throw new WorkflowStepError(
            'settlement_authority_lost',
            'internal invariant violation: the settlement run lost its authorizing action request',
          );
        }

        if (checkpointShape.nextIndex >= input.windows.length) {
          return {
            type: 'done',
            output: { settled: checkpointShape.settled, skipped: checkpointShape.skipped },
          };
        }
        const window = input.windows[checkpointShape.nextIndex]!;
        const settled = [...checkpointShape.settled];
        let skipped = checkpointShape.skipped;
        let nextIndex = checkpointShape.nextIndex;
        let resumeInSeconds: number | undefined;
        try {
          const result = await settleWindowInternal(ctx, window, actionRequestId);
          settled.push(result.settlement.id);
          nextIndex += 1;
        } catch (error) {
          if (error instanceof ProviderBillingError && error.code === 'settlement_nothing_to_settle') {
            skipped += 1;
            nextIndex += 1;
          } else if (error instanceof ProviderBillingError && error.code === 'settlement_in_flight') {
            // Another holder is charging this window under its lease —
            // checkpoint in place and retry after the lease window.
            resumeInSeconds = 60;
          } else {
            throw error;
          }
        }
        const progress = { settled, skipped, nextIndex, actionRequestId };
        if (nextIndex >= input.windows.length) {
          return { type: 'done', output: { settled, skipped } };
        }
        return { type: 'checkpoint', progress, resumeInSeconds };
      },
    },
  };
}
