// Integration tests for the provider-billing module against the embedded
// PostgreSQL (PGlite, `:memory:`) through the db port. Covers the W090
// acceptance: "provider cost can be attributed to tenant/capability/
// execution; budget policy can block/route usage; supported provider
// settlement produces an auditable receipt; unsupported direct-billing
// provider does not break capability flow."
//
//  * arrangements — claim-gated registration (aurum-mediated with a wired
//    settlement adapter vs the explicit direct-customer fallback with its
//    registered external billing requirement), upsert, reads;
//  * the usage ledger — append-only, idempotent by (tenant, gateway,
//    dedupeKey), attribution WITHOUT any arrangement (capability flow
//    never breaks), filtered listing, per-capability summaries with
//    distinct execution counts;
//  * budget policy — four scopes, block and observe enforcement over the
//    UTC calendar month, no shadowing (a wide block bites alongside a
//    narrow budget), append-only enforcement evidence, routing reads;
//  * settlement — the W009 EXECUTE authority gate (approval-required
//    replay through decideApproval, forbidden refusal, policy-allowed
//    path), window claims that settle each usage record exactly once
//    (overlapping windows claim disjoint usage), idempotent charging
//    through the settlement id, the auditable receipt with a recomputed
//    SHA-256 digest (tamper-evident), adapter failure localization (the
//    canonical W089 failure lands on the settlement row, never a raw
//    provider error) and safe re-drives of failed windows, the
//    in-flight charge lease, the direct-customer canonical refusal, and
//    adapter pluggability (charge-on-account AND prepaid draw-down);
//  * the W034 composition bridge — real llm-gateway executions land in
//    the billing ledger through the llm module's public contract,
//    idempotently, and settle through the same canonical path;
//  * the W080 composition bridge — a durable settlement workflow run
//    gated by the engine's own approval wait, one window per invocation,
//    checkpointed progress, resumable by a fresh engine generation;
//  * tenant isolation + storage discipline (append-only triggers, the
//    guarded settlement state machine, frozen budget scopes).

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { systemClock } from '@/infra/clock';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import {
  decideApproval,
  listActionRequests,
  setAuthorityPolicy,
} from '@/modules/actions/contract';
import {
  invokeLlm,
  registerAiProviderAccount,
  setLlmTransport,
  type LlmTransport,
  type LlmTransportReceipt,
  type LlmTransportRequest,
} from '@/modules/llm/contract';
import {
  createWorkflowEngine,
  getRun,
  registerWorkflow,
  startRun,
} from '@/modules/workflow/contract';
import { runMigrations } from '../../../../scripts/migrate';
import { ProviderBillingError } from '../errors';
import {
  createPlatformAccountSettlementAdapter,
  createPrepaidBalanceSettlementAdapter,
} from '../adapters/index';
import type { SettlementHttpClient, SettlementHttpRequest, SettlementHttpResponse } from '../adapters/shared';
import * as billingContract from '../contract';

const {
  createSettlementWorkflowBindings,
  enforceProviderBudget,
  getPaymentArrangement,
  getSettlement,
  getSettlementReceipt,
  getUsageRecord,
  getUsageSummary,
  importLlmUsage,
  listBudgetEvents,
  listPaymentArrangements,
  listProviderBudgets,
  listSettlementEvents,
  listSettlements,
  listUsageRecords,
  listWiredSettlementAdapters,
  recordProviderUsage,
  registerPaymentArrangement,
  retireProviderBudget,
  routeWithinBudget,
  setProviderBudget,
  settleProviderUsage,
  wireSettlementAdapters,
} = billingContract;

// ---------------------------------------------------------------------------
// A scripted billing backend speaking both adapters' native dialects
// ---------------------------------------------------------------------------

/**
 * A fake billing-provider backend implementing the platform-account and
 * prepaid-ledger wire dialects over the shared SettlementHttpClient port,
 * with idempotency-key replay (the exactly-once charging contract) and
 * failure injection. All its times derive from the test clock.
 */
class ScriptedBillingBackend implements SettlementHttpClient {
  readonly requests: SettlementHttpRequest[] = [];
  readonly chargeCalls: Array<{ key: string; amountMinor: number; adapter: string }> = [];
  /** Per-idempotency-key applied charges (adapter-prefixed keys). */
  readonly applied = new Map<string, { receiptRef: string; amountMinor: number }>();
  /** Simulated statuses for the NEXT request (e.g. 503 outage). */
  nextStatus: number | null = null;
  /** Simulated per-adapter failure (500 for one adapter only). */
  adapterOutage: string | null = null;
  private counter = 0;
  private balance = 5_000_000;

  private receiptRef(prefix: string): string {
    this.counter += 1;
    return `${prefix}_${String(this.counter).padStart(6, '0')}`;
  }

  resetOutages(): void {
    this.nextStatus = null;
    this.adapterOutage = null;
  }

  async request(request: SettlementHttpRequest): Promise<SettlementHttpResponse> {
    this.requests.push(request);
    if (this.nextStatus !== null) {
      const status = this.nextStatus;
      this.nextStatus = null;
      return { status, body: { error: 'simulated billing failure' } };
    }
    if (this.adapterOutage !== null) {
      const auth = request.headers?.Authorization ?? '';
      if (auth.includes(this.adapterOutage)) {
        return { status: 500, body: { error: 'internal billing error' } };
      }
    }
    if (request.method === 'POST' && request.path === '/v1/charges') {
      const body = request.body as { idempotency_key?: string; amount_minor?: number };
      const key = `platform:${body.idempotency_key ?? ''}`;
      this.chargeCalls.push({ key, amountMinor: body.amount_minor ?? 0, adapter: 'platform-account' });
      const existing = this.applied.get(key);
      if (existing !== undefined) {
        return {
          status: 200,
          body: {
            charge_id: existing.receiptRef,
            status: 'succeeded',
            duplicate: true,
            amount_minor: existing.amountMinor,
            currency: 'USD',
            occurred_at: new Date(systemClock.now()).toISOString(),
          },
        };
      }
      const receiptRef = this.receiptRef('chrg');
      this.applied.set(key, { receiptRef, amountMinor: body.amount_minor ?? 0 });
      return {
        status: 201,
        body: {
          charge_id: receiptRef,
          status: 'succeeded',
          amount_minor: body.amount_minor ?? 0,
          currency: 'USD',
          occurred_at: new Date(systemClock.now()).toISOString(),
        },
      };
    }
    if (request.method === 'POST' && request.path === '/v1/debits') {
      const body = request.body as { idempotency_key?: string; amount_minor?: number };
      const key = `prepaid:${body.idempotency_key ?? ''}`;
      this.chargeCalls.push({ key, amountMinor: body.amount_minor ?? 0, adapter: 'prepaid-balance' });
      const existing = this.applied.get(key);
      if (existing !== undefined) {
        return {
          status: 200,
          body: {
            debit_id: existing.receiptRef,
            duplicate: true,
            amount_minor: existing.amountMinor,
            currency: 'USD',
            balance_minor_after: this.balance,
            occurred_at: new Date(systemClock.now()).toISOString(),
          },
        };
      }
      const amount = body.amount_minor ?? 0;
      if (amount > this.balance) {
        return { status: 409, body: { error: 'insufficient_balance' } };
      }
      this.balance -= amount;
      const receiptRef = this.receiptRef('dbt');
      this.applied.set(key, { receiptRef, amountMinor: amount });
      return {
        status: 201,
        body: {
          debit_id: receiptRef,
          amount_minor: amount,
          currency: 'USD',
          balance_minor_after: this.balance,
          occurred_at: new Date(systemClock.now()).toISOString(),
        },
      };
    }
    return { status: 404, body: { error: 'unknown endpoint' } };
  }
}

// ---------------------------------------------------------------------------
// A fake llm transport (openai completion dialect) for the W034 bridge
// ---------------------------------------------------------------------------

class FakeLlmTransport implements LlmTransport {
  readonly requests: LlmTransportRequest[] = [];
  private counter = 0;

  async send(request: LlmTransportRequest): Promise<LlmTransportReceipt> {
    this.requests.push(request);
    this.counter += 1;
    const executionId = `fake-llm-${String(this.counter).padStart(4, '0')}`;
    return {
      status: 'delivered',
      payload: {
        id: executionId,
        choices: [{ message: { role: 'assistant', content: 'Yes — provider-neutrally.' } }],
        usage: { prompt_tokens: 1_000, completion_tokens: 500 },
      },
      providerExecutionId: executionId,
      detail: null,
    };
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let clockMs = Date.parse('2026-10-05T12:00:00Z');
let backend: ScriptedBillingBackend;
let platform: ReturnType<typeof createPlatformAccountSettlementAdapter>;
let prepaid: ReturnType<typeof createPrepaidBalanceSettlementAdapter>;

const tenantMain = newId();

/** Fake adapter API keys — assembled from fragments at runtime. */
const platformKey = ['pb_platform_', 'it', '_fragment'].join('');
const prepaidKey = ['pb_prepaid_', 'it', '_fragment'].join('');

function adminOf(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: ['provider-billing:administer'] };
}

function memberOf(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: [] };
}

function policyAdminOf(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: ['actions:administer'] };
}

function approverOf(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: ['actions:approve'] };
}

function llmAdminOf(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: ['llm:administer'] };
}

async function expectCode(
  code: ProviderBillingError['code'],
  fn: () => Promise<unknown>,
): Promise<ProviderBillingError> {
  try {
    await fn();
    throw new Error(`expected ProviderBillingError('${code}') but the call succeeded`);
  } catch (error) {
    if (!(error instanceof ProviderBillingError)) throw error;
    expect(error.code).toBe(code);
    return error;
  }
}

async function allowSettlements(tenantId: string): Promise<void> {
  await setAuthorityPolicy(policyAdminOf(tenantId), {
    actionKind: 'provider-settlement',
    approvalLevels: [],
    forbiddenLevels: [],
    note: 'settlements are pre-authorized for the billing tests',
  });
}

const OCTOBER = { from: '2026-10-01T00:00:00Z', to: '2026-11-01T00:00:00Z' };
const NOVEMBER = { from: '2026-11-01T00:00:00Z', to: '2026-12-01T00:00:00Z' };

async function recordUsage(
  ctx: TenantContext,
  spec: {
    gateway?: string;
    provider?: string;
    capability?: string;
    costMinor: number;
    executionRef?: string;
    dedupeKey: string;
    occurredAt?: string;
  },
) {
  const result = await recordProviderUsage(ctx, {
    gateway: spec.gateway ?? 'llm',
    provider: spec.provider ?? 'openai',
    capability: spec.capability ?? 'text-generation',
    costMinor: spec.costMinor,
    executionRef: spec.executionRef ?? null,
    dedupeKey: spec.dedupeKey,
    occurredAt: spec.occurredAt ?? '2026-10-05T10:00:00Z',
  });
  return result.record;
}

beforeAll(async () => {
  await runMigrations(getDb());
});

afterAll(async () => {
  await closeDb();
});

beforeEach(() => {
  clockMs = Date.parse('2026-10-05T12:00:00Z');
  vi.spyOn(systemClock, 'now').mockImplementation(() => new Date(clockMs));
  backend = new ScriptedBillingBackend();
  platform = createPlatformAccountSettlementAdapter({
    baseUrl: 'https://billing.platform.example',
    apiKey: platformKey,
    httpClient: backend,
  });
  prepaid = createPrepaidBalanceSettlementAdapter({
    baseUrl: 'https://prepaid.billing.example',
    apiKey: prepaidKey,
    httpClient: backend,
  });
  wireSettlementAdapters([platform, prepaid]);
});

afterEach(() => {
  wireSettlementAdapters(null);
  setLlmTransport(null);
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Payment arrangements
// ---------------------------------------------------------------------------

describe('provider-billing service — payment arrangements', () => {
  it('guards registration behind the administer claim', async () => {
    await expectCode('unauthorized', () =>
      registerPaymentArrangement(memberOf(tenantMain), {
        gateway: 'llm',
        provider: 'openai',
        arrangement: 'aurum-mediated',
        settlementAdapterKey: 'platform-account',
      }),
    );
  });

  it('registers, upserts and reads arrangements (mediated and direct)', async () => {
    const admin = adminOf(tenantMain);
    const mediated = await registerPaymentArrangement(admin, {
      gateway: 'llm',
      provider: 'openai',
      arrangement: 'aurum-mediated',
      settlementAdapterKey: 'platform-account',
    });
    expect(mediated.arrangement).toBe('aurum-mediated');
    expect(mediated.settlementAdapterKey).toBe('platform-account');
    expect(mediated.directBillingNote).toBeNull();
    expect(mediated.status).toBe('active');

    // Upsert the same (gateway, provider) onto the direct fallback.
    const direct = await registerPaymentArrangement(admin, {
      gateway: 'llm',
      provider: 'openai',
      arrangement: 'direct-customer',
      directBillingNote: 'This provider bills your company directly; Aurum still tracks cost and budgets.',
    });
    expect(direct.arrangement).toBe('direct-customer');
    expect(direct.settlementAdapterKey).toBeNull();
    expect(direct.directBillingNote).toContain('bills your company directly');
    expect(direct.id).toBe(mediated.id); // same row, upserted

    // A second mediated arrangement on another provider.
    const second = await registerPaymentArrangement(admin, {
      gateway: 'llm',
      provider: 'anthropic',
      arrangement: 'aurum-mediated',
      settlementAdapterKey: 'prepaid-balance',
    });
    expect(second.id).not.toBe(mediated.id);

    const read = await getPaymentArrangement(memberOf(tenantMain), {
      gateway: 'llm',
      provider: 'anthropic',
    });
    expect(read.arrangement).toBe('aurum-mediated');

    const listed = await listPaymentArrangements(memberOf(tenantMain), {
      arrangement: 'aurum-mediated',
    });
    expect(listed.map((a) => a.provider)).toEqual(['anthropic']);

    await expectCode('arrangement_not_found', () =>
      getPaymentArrangement(memberOf(tenantMain), { gateway: 'agents', provider: 'runtime-x' }),
    );

    // Restore the mediated arrangement for later suites in this tenant.
    await registerPaymentArrangement(admin, {
      gateway: 'llm',
      provider: 'openai',
      arrangement: 'aurum-mediated',
      settlementAdapterKey: 'platform-account',
    });
  });

  it('rejects invalid arrangement shapes', async () => {
    const admin = adminOf(tenantMain);
    await expectCode('invalid_input', () =>
      registerPaymentArrangement(admin, {
        gateway: 'llm',
        provider: 'openai',
        arrangement: 'aurum-mediated',
      }),
    );
    await expectCode('invalid_input', () =>
      registerPaymentArrangement(admin, {
        gateway: 'llm',
        provider: 'openai',
        arrangement: 'direct-customer',
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// The usage ledger (cost attribution)
// ---------------------------------------------------------------------------

describe('provider-billing service — the usage ledger', () => {
  it('records usage idempotently with full attribution and no arrangement required', async () => {
    const ctx = memberOf(newId());
    // NO payment arrangement exists for this provider — attribution still works.
    const first = await recordUsage(ctx, {
      provider: 'unregistered-provider',
      costMinor: 1_234,
      executionRef: 'exec-42',
      dedupeKey: 'usage-1',
    });
    expect(first.costMinor).toBe(1_234);
    expect(first.executionRef).toBe('exec-42');
    expect(first.currency).toBe('USD');
    expect(first.source).toBe('gateway');
    expect(first.occurredAt).toBe('2026-10-05T10:00:00.000Z');

    // Same dedupe key replays the original record (first write wins).
    const replay = await recordProviderUsage(ctx, {
      gateway: 'llm',
      provider: 'unregistered-provider',
      capability: 'text-generation',
      costMinor: 9_999,
      dedupeKey: 'usage-1',
    });
    expect(replay.created).toBe(false);
    expect(replay.record.id).toBe(first.id);
    expect(replay.record.costMinor).toBe(1_234);

    // The dedupe namespace is per gateway.
    const otherGateway = await recordProviderUsage(ctx, {
      gateway: 'agents',
      provider: 'unregistered-provider',
      capability: 'text-generation',
      costMinor: 5,
      dedupeKey: 'usage-1',
    });
    expect(otherGateway.record.id).not.toBe(first.id);
  });

  it('lists with filters and summarizes per capability with execution counts', async () => {
    const ctx = memberOf(newId());
    await recordUsage(ctx, { provider: 'openai', capability: 'text-generation', costMinor: 100, executionRef: 'e1', dedupeKey: 'sum-1' });
    await recordUsage(ctx, { provider: 'openai', capability: 'text-generation', costMinor: 200, executionRef: 'e2', dedupeKey: 'sum-2' });
    await recordUsage(ctx, { provider: 'openai', capability: 'embedding', costMinor: 50, dedupeKey: 'sum-3' });
    await recordUsage(ctx, { provider: 'anthropic', capability: 'text-generation', costMinor: 75, executionRef: 'e3', dedupeKey: 'sum-4' });
    await recordUsage(ctx, { provider: 'openai', capability: 'text-generation', costMinor: 25, dedupeKey: 'nov', occurredAt: '2026-11-02T10:00:00Z' });

    const openaiOctober = await listUsageRecords(ctx, {
      gateway: 'llm',
      provider: 'openai',
      since: OCTOBER.from,
      until: OCTOBER.to,
    });
    expect(openaiOctober.map((r) => r.dedupeKey).sort()).toEqual(['sum-1', 'sum-2', 'sum-3']);

    const byExecution = await listUsageRecords(ctx, { executionRef: 'e2' });
    expect(byExecution).toHaveLength(1);
    expect(byExecution[0]!.costMinor).toBe(200);

    const summary = await getUsageSummary(ctx, { gateway: 'llm', since: OCTOBER.from, until: OCTOBER.to });
    expect(summary.records).toBe(4);
    expect(summary.costMinor).toBe(425);
    expect(summary.executions).toBe(3);
    expect(summary.rows.map((r) => [r.provider, r.capability, r.costMinor])).toEqual([
      ['openai', 'text-generation', 300],
      ['anthropic', 'text-generation', 75],
      ['openai', 'embedding', 50],
    ]);

    await expectCode('usage_not_found', () => getUsageRecord(ctx, { usageId: newId() }));
    const fetched = await getUsageRecord(ctx, { usageId: byExecution[0]!.id });
    expect(fetched.executionRef).toBe('e2');
  });
});

// ---------------------------------------------------------------------------
// Budget policy
// ---------------------------------------------------------------------------

describe('provider-billing service — budget policy', () => {
  it('guards budget administration behind the administer claim', async () => {
    await expectCode('unauthorized', () =>
      setProviderBudget(memberOf(tenantMain), { scope: 'tenant', budgetMinor: 1000, enforcement: 'block' }),
    );
  });

  it('sets, upserts, retires and lists budgets', async () => {
    const tenant = newId();
    const admin = adminOf(tenant);
    const member = memberOf(tenant);
    const tenantWide = await setProviderBudget(admin, {
      scope: 'tenant',
      budgetMinor: 100_000,
      enforcement: 'observe',
      note: 'the tenant-wide ceiling',
    });
    expect(tenantWide.scopeKey).toBe('');
    const updated = await setProviderBudget(admin, {
      scope: 'tenant',
      budgetMinor: 120_000,
      enforcement: 'block',
    });
    expect(updated.id).toBe(tenantWide.id);
    expect(updated.budgetMinor).toBe(120_000);
    expect(updated.enforcement).toBe('block');

    const providerScoped = await setProviderBudget(admin, {
      scope: 'provider',
      gateway: 'llm',
      provider: 'openai',
      budgetMinor: 5_000,
      enforcement: 'block',
    });
    expect(providerScoped.scopeKey).toBe('llm:openai');

    const active = await listProviderBudgets(member, { status: 'active' });
    expect(active.map((b) => b.scopeKey).sort()).toEqual(['', 'llm:openai']);

    const retired = await retireProviderBudget(admin, { budgetId: providerScoped.id });
    expect(retired.status).toBe('retired');
    await expectCode('budget_not_found', () =>
      retireProviderBudget(admin, { budgetId: providerScoped.id }),
    );

    // Gateway-filtered listing includes tenant-wide rows (they cover it);
    // retired rows stay visible (their audit trail is retained).
    const covering = await listProviderBudgets(member, { gateway: 'llm' });
    expect(covering.map((b) => b.scopeKey)).toEqual(['', 'llm:openai']);

    await expectCode('invalid_input', () =>
      setProviderBudget(admin, { scope: 'gateway', budgetMinor: 1, enforcement: 'block' }),
    );
  });

  it('enforcement blocks projected usage that would exceed a covering block budget, with evidence', async () => {
    const tenant = newId();
    const admin = adminOf(tenant);
    const ctx = memberOf(tenant);
    await setProviderBudget(admin, { scope: 'tenant', budgetMinor: 10_000, enforcement: 'block' });

    // Spend 9,900 this month; a 200 projection exceeds the 10,000 budget.
    await recordUsage(ctx, { provider: 'openai', costMinor: 9_900, dedupeKey: 'budget-block-1' });
    const blocked = await enforceProviderBudget(ctx, {
      gateway: 'llm',
      provider: 'openai',
      capability: 'text-generation',
      projectedCostMinor: 200,
    });
    expect(blocked.decision).toBe('block');
    expect(blocked.reason).toContain('budget policy blocks llm/openai/text-generation');
    expect(blocked.violations).toHaveLength(1);
    expect(blocked.violations[0]!.overageMinor).toBe(100);

    const events = await listBudgetEvents(ctx, { event: 'blocked' });
    expect(events).toHaveLength(1);
    expect(events[0]!.scopeKey).toBe('');
    expect((events[0]!.enforcement as { decision: string }).decision).toBe('block');

    // A projection that fits is allowed and records nothing.
    const allowed = await enforceProviderBudget(ctx, {
      gateway: 'llm',
      provider: 'openai',
      capability: 'text-generation',
      projectedCostMinor: 100,
    });
    expect(allowed.decision).toBe('allow');
    expect(await listBudgetEvents(ctx, {})).toHaveLength(1);
  });

  it('observe budgets warn instead of block; scoped budgets count only their scope; no shadowing', async () => {
    const tenant = newId();
    const admin = adminOf(tenant);
    const ctx = memberOf(tenant);
    await setProviderBudget(admin, { scope: 'tenant', budgetMinor: 1_000, enforcement: 'observe' });
    await setProviderBudget(admin, {
      scope: 'capability',
      gateway: 'llm',
      provider: 'openai',
      capability: 'text-generation',
      budgetMinor: 500,
      enforcement: 'block',
    });

    // Capability-scoped spend counts ONLY text-generation records (600),
    // even though the tenant-wide spend (1,100 via embedding) is over.
    await recordUsage(ctx, { provider: 'openai', capability: 'text-generation', costMinor: 600, dedupeKey: 'scope-1' });
    await recordUsage(ctx, { provider: 'openai', capability: 'embedding', costMinor: 500, dedupeKey: 'scope-2' });

    // Embedding: the capability budget does not cover it; the tenant-wide
    // observe budget is exceeded → warning, allowed.
    const embedding = await enforceProviderBudget(ctx, {
      gateway: 'llm',
      provider: 'openai',
      capability: 'embedding',
      projectedCostMinor: 0,
    });
    expect(embedding.decision).toBe('allow');
    expect(embedding.warnings.map((w) => w.scopeKey)).toEqual(['']);
    expect(embedding.warnings[0]!.spendMinor).toBe(1_100);

    // Text-generation: the capability block budget (500) is exceeded by the
    // recorded 600 alone → block — even though the tenant-wide row is observe.
    const generation = await enforceProviderBudget(ctx, {
      gateway: 'llm',
      provider: 'openai',
      capability: 'text-generation',
      projectedCostMinor: 0,
    });
    expect(generation.decision).toBe('block');
    expect(generation.violations[0]!.posture.scopeKey).toBe('llm:openai:text-generation');
    expect(generation.warnings.map((w) => w.scopeKey)).toEqual(['']); // no shadowing
  });

  it('routes candidate targets through the same evaluation in input order', async () => {
    const tenant = newId();
    const admin = adminOf(tenant);
    const ctx = memberOf(tenant);
    await setProviderBudget(admin, {
      scope: 'provider',
      gateway: 'llm',
      provider: 'openai',
      budgetMinor: 1_000,
      enforcement: 'block',
    });
    await recordUsage(ctx, { provider: 'openai', costMinor: 900, dedupeKey: 'route-1' });

    const result = await routeWithinBudget(ctx, {
      candidates: [
        { gateway: 'llm', provider: 'openai', capability: 'text-generation', projectedCostMinor: 200 },
        { gateway: 'llm', provider: 'anthropic', capability: 'text-generation', projectedCostMinor: 5_000 },
        { gateway: 'llm', provider: 'openai', capability: 'embedding', projectedCostMinor: 50 },
      ],
    });
    expect(result.routed.map((c) => c.projectedCostMinor)).toEqual([5_000, 50]);
    expect(result.blocked).toHaveLength(1);
    expect(result.blocked[0]!.provider).toBe('openai');
    expect(result.blocked[0]!.reason).toContain('budget policy blocks');
  });
});

// ---------------------------------------------------------------------------
// Settlement
// ---------------------------------------------------------------------------

describe('provider-billing service — settlement (the auditable receipt)', () => {
  async function seedMediated(tenantId: string): Promise<void> {
    await registerPaymentArrangement(adminOf(tenantId), {
      gateway: 'llm',
      provider: 'openai',
      arrangement: 'aurum-mediated',
      settlementAdapterKey: 'platform-account',
    });
    await allowSettlements(tenantId);
    const ctx = memberOf(tenantId);
    await recordUsage(ctx, { provider: 'openai', capability: 'text-generation', costMinor: 1_000, executionRef: 'settle-e1', dedupeKey: 'settle-1' });
    await recordUsage(ctx, { provider: 'openai', capability: 'embedding', costMinor: 250, dedupeKey: 'settle-2' });
  }

  it('settles a window through the wired adapter with an auditable, digest-verified receipt', async () => {
    const tenant = newId();
    await seedMediated(tenant);
    const ctx = memberOf(tenant);

    const chargeCallsBefore = backend.chargeCalls.length;
    const result = await settleProviderUsage(ctx, {
      gateway: 'llm',
      provider: 'openai',
      windowFrom: OCTOBER.from,
      windowTo: OCTOBER.to,
    });
    const settlement = result.settlement;
    expect(settlement.status).toBe('settled');
    expect(settlement.arrangement).toBe('aurum-mediated');
    expect(settlement.settlementAdapterKey).toBe('platform-account');
    expect(settlement.lineCount).toBe(2);
    expect(settlement.amountMinor).toBe(1_250);
    expect(settlement.receiptRef).toMatch(/^chrg_\d{6}$/);
    expect(settlement.leaseExpiresAt).toBeNull();

    const receipt = result.receipt!;
    expect(receipt.amountMinor).toBe(1_250);
    expect(receipt.usage.records).toBe(2);
    expect(receipt.usage.executions).toBe(1);
    expect(receipt.usage.byCapability.map((l) => [l.capability, l.costMinor])).toEqual([
      ['text-generation', 1_000],
      ['embedding', 250],
    ]);
    expect(receipt.receiptRef).toBe(settlement.receiptRef);
    expect(receipt.receiptDigest).toMatch(/^[0-9a-f]{64}$/);

    // One charge, keyed by the settlement id — exactly-once.
    expect(backend.chargeCalls.length).toBe(chargeCallsBefore + 1);
    expect(backend.chargeCalls[backend.chargeCalls.length - 1]!.key).toBe(`platform:${settlement.id}`);

    // The read path RECOMPUTES the digest and agrees.
    const reread = await getSettlementReceipt(ctx, { settlementId: settlement.id });
    expect(reread.receiptDigest).toBe(receipt.receiptDigest);
    expect(reread.usage).toEqual(receipt.usage);

    const events = await listSettlementEvents(ctx, { settlementId: settlement.id });
    expect(events.map((e) => e.event)).toEqual(['window_claimed', 'charge_succeeded']);
    expect(events[0]!.seq).toBeLessThan(events[1]!.seq);

    // Retrying the SAME window replays the settled settlement — no new charge.
    const retry = await settleProviderUsage(ctx, {
      gateway: 'llm',
      provider: 'openai',
      windowFrom: OCTOBER.from,
      windowTo: OCTOBER.to,
    });
    expect(retry.settlement.id).toBe(settlement.id);
    expect(retry.settlement.status).toBe('settled');
    expect(backend.chargeCalls.length).toBe(chargeCallsBefore + 1);
  });

  it('overlapping windows claim DISJOINT usage — a record settles exactly once', async () => {
    const tenant = newId();
    await registerPaymentArrangement(adminOf(tenant), {
      gateway: 'llm',
      provider: 'openai',
      arrangement: 'aurum-mediated',
      settlementAdapterKey: 'platform-account',
    });
    await allowSettlements(tenant);
    const ctx = memberOf(tenant);
    await recordUsage(ctx, { provider: 'openai', costMinor: 1_000, dedupeKey: 'overlap-1', occurredAt: '2026-10-05T10:00:00Z' });
    await recordUsage(ctx, { provider: 'openai', costMinor: 2_000, dedupeKey: 'overlap-2', occurredAt: '2026-10-20T10:00:00Z' });
    await recordUsage(ctx, { provider: 'openai', costMinor: 4_000, dedupeKey: 'overlap-3', occurredAt: '2026-11-05T10:00:00Z' });

    const first = await settleProviderUsage(ctx, {
      gateway: 'llm',
      provider: 'openai',
      windowFrom: '2026-10-01T00:00:00Z',
      windowTo: '2026-10-15T00:00:00Z',
    });
    expect(first.settlement.amountMinor).toBe(1_000);

    // An overlapping WIDER window claims only the remaining unsettled usage.
    const second = await settleProviderUsage(ctx, {
      gateway: 'llm',
      provider: 'openai',
      windowFrom: '2026-10-01T00:00:00Z',
      windowTo: '2026-12-01T00:00:00Z',
    });
    expect(second.settlement.id).not.toBe(first.settlement.id);
    expect(second.settlement.amountMinor).toBe(6_000);
    expect(second.settlement.lineCount).toBe(2);

    // A window with nothing left refuses explicitly (a DIFFERENT window
    // key with no unsettled usage — the settled keys above replay).
    await expectCode('settlement_nothing_to_settle', () =>
      settleProviderUsage(ctx, {
        gateway: 'llm',
        provider: 'openai',
        windowFrom: '2025-01-01T00:00:00Z',
        windowTo: '2025-02-01T00:00:00Z',
      }),
    );
  });

  it('routes settlement through the W009 authority gate (approval replay + forbidden)', async () => {
    const tenant = newId();
    await registerPaymentArrangement(adminOf(tenant), {
      gateway: 'llm',
      provider: 'openai',
      arrangement: 'aurum-mediated',
      settlementAdapterKey: 'platform-account',
    });
    const ctx = memberOf(tenant);
    await recordUsage(ctx, { provider: 'openai', costMinor: 500, dedupeKey: 'gate-1' });

    // Default policy: EXECUTE is approval-gated.
    const error = await expectCode('settlement_approval_required', () =>
      settleProviderUsage(ctx, {
        gateway: 'llm',
        provider: 'openai',
        windowFrom: OCTOBER.from,
        windowTo: OCTOBER.to,
        idempotencyKey: 'settle-gate-1',
      }),
    );
    expect(error.actionRequestId).toBeTruthy();

    const requests = await listActionRequests(ctx, { actionKind: 'provider-settlement' });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.status).toBe('pending');
    expect(requests[0]!.id).toBe(error.actionRequestId);

    // A human approves; the retry with the SAME key replays the request.
    await decideApproval(approverOf(tenant), { requestId: requests[0]!.id, decision: 'approve' });
    const settled = await settleProviderUsage(ctx, {
      gateway: 'llm',
      provider: 'openai',
      windowFrom: OCTOBER.from,
      windowTo: OCTOBER.to,
      idempotencyKey: 'settle-gate-1',
    });
    expect(settled.settlement.status).toBe('settled');
    expect(settled.settlement.actionRequestId).toBe(requests[0]!.id);

    // A forbidden policy refuses outright.
    const tenant2 = newId();
    await registerPaymentArrangement(adminOf(tenant2), {
      gateway: 'llm',
      provider: 'openai',
      arrangement: 'aurum-mediated',
      settlementAdapterKey: 'platform-account',
    });
    await setAuthorityPolicy(policyAdminOf(tenant2), {
      actionKind: 'provider-settlement',
      forbiddenLevels: ['EXECUTE'],
    });
    const ctx2 = memberOf(tenant2);
    await recordUsage(ctx2, { provider: 'openai', costMinor: 100, dedupeKey: 'gate-2' });
    await expectCode('settlement_forbidden', () =>
      settleProviderUsage(ctx2, {
        gateway: 'llm',
        provider: 'openai',
        windowFrom: OCTOBER.from,
        windowTo: OCTOBER.to,
      }),
    );
  });

  it('localizes adapter failures canonically and re-drives failed windows safely', async () => {
    const tenant = newId();
    await seedMediated(tenant);
    const ctx = memberOf(tenant);

    // Inject a 503 outage for the charge.
    backend.nextStatus = 503;
    const failure = await expectCode('settlement_adapter_failure', () =>
      settleProviderUsage(ctx, {
        gateway: 'llm',
        provider: 'openai',
        windowFrom: OCTOBER.from,
        windowTo: OCTOBER.to,
        idempotencyKey: 'settle-fail-1',
      }),
    );
    expect(failure.failure).toMatchObject({
      category: 'provider_unavailable',
      retryable: true,
      gateway: 'provider-billing',
      provider: 'platform-account',
    });

    const failed = (await listSettlements(ctx, { status: 'failed' }))[0]!;
    expect(failed.failure!.category).toBe('provider_unavailable');
    expect(failed.failureDetail).toBeTruthy();
    expect(failed.receiptRef).toBeNull();
    const failedEvents = await listSettlementEvents(ctx, { settlementId: failed.id });
    expect(failedEvents.map((e) => e.event)).toEqual(['window_claimed', 'charge_failed']);

    // The usage stays claimed by the failed settlement (no double claim).
    backend.resetOutages();
    const retried = await settleProviderUsage(ctx, {
      gateway: 'llm',
      provider: 'openai',
      windowFrom: OCTOBER.from,
      windowTo: OCTOBER.to,
      idempotencyKey: 'settle-fail-2',
    });
    // The re-drive reuses the SAME settlement row (id) and settles it once.
    expect(retried.settlement.id).toBe(failed.id);
    expect(retried.settlement.status).toBe('settled');
    expect(retried.settlement.amountMinor).toBe(1_250);
    const eventsAfter = await listSettlementEvents(ctx, { settlementId: failed.id });
    expect(eventsAfter.map((e) => e.event)).toEqual([
      'window_claimed',
      'charge_failed',
      'charge_succeeded',
    ]);

    // An adapter outage on a DIFFERENT adapter leaves the other routable
    // (failure isolation across adapters).
    const tenant2 = newId();
    await registerPaymentArrangement(adminOf(tenant2), {
      gateway: 'llm',
      provider: 'anthropic',
      arrangement: 'aurum-mediated',
      settlementAdapterKey: 'prepaid-balance',
    });
    await allowSettlements(tenant2);
    const ctx2 = memberOf(tenant2);
    await recordUsage(ctx2, { provider: 'anthropic', costMinor: 300, dedupeKey: 'iso-1' });
    backend.adapterOutage = prepaidKey;
    await expectCode('settlement_adapter_failure', () =>
      settleProviderUsage(ctx2, {
        gateway: 'llm',
        provider: 'anthropic',
        windowFrom: OCTOBER.from,
        windowTo: OCTOBER.to,
      }),
    );
    backend.resetOutages();
    const viaPrepaid = await settleProviderUsage(ctx2, {
      gateway: 'llm',
      provider: 'anthropic',
      windowFrom: OCTOBER.from,
      windowTo: OCTOBER.to,
    });
    expect(viaPrepaid.settlement.status).toBe('settled');
    expect((viaPrepaid.receipt!.receiptPayload as Record<string, unknown>).kind).toBe(
      'prepaid-balance-debit',
    );
  });

  it('refuses settlement canonically for unwired adapters and in-flight leases', async () => {
    const tenant = newId();
    await seedMediated(tenant);
    const ctx = memberOf(tenant);

    // Nothing wired → explicit refusal.
    wireSettlementAdapters(null);
    await expectCode('settlement_adapter_unavailable', () =>
      settleProviderUsage(ctx, {
        gateway: 'llm',
        provider: 'openai',
        windowFrom: OCTOBER.from,
        windowTo: OCTOBER.to,
      }),
    );
    expect(listWiredSettlementAdapters()).toEqual([]);
    wireSettlementAdapters([platform, prepaid]);
    expect(listWiredSettlementAdapters().map((a) => a.key).sort()).toEqual([
      'platform-account',
      'prepaid-balance',
    ]);

    // A settling row inside its charge lease refuses with in-flight.
    const tenant2 = newId();
    await seedMediated(tenant2);
    const ctx2 = memberOf(tenant2);
    backend.nextStatus = 503;
    await expectCode('settlement_adapter_failure', () =>
      settleProviderUsage(ctx2, {
        gateway: 'llm',
        provider: 'openai',
        windowFrom: OCTOBER.from,
        windowTo: OCTOBER.to,
      }),
    );
    const failedRow = (await listSettlements(ctx2, { status: 'failed' }))[0]!;
    await getDb().query(
      `UPDATE provider_settlements SET status = 'settling', lease_expires_at = $3,
         failure = NULL, failure_detail = NULL WHERE tenant_id = $1 AND id = $2`,
      [tenant2, failedRow.id, '2026-10-05T13:00:00Z'],
    );
    await expectCode('settlement_in_flight', () =>
      settleProviderUsage(ctx2, {
        gateway: 'llm',
        provider: 'openai',
        windowFrom: OCTOBER.from,
        windowTo: OCTOBER.to,
      }),
    );
  });

  it('the direct-customer fallback refuses settlement without breaking capability flow', async () => {
    const tenant = newId();
    const admin = adminOf(tenant);
    const ctx = memberOf(tenant);
    const note = 'This provider bills your company directly under your own agreement.';
    await registerPaymentArrangement(admin, {
      gateway: 'llm',
      provider: 'directonly',
      arrangement: 'direct-customer',
      directBillingNote: note,
    });
    await allowSettlements(tenant);

    // Capability flow unbroken: usage attributes, budgets enforce.
    const usage = await recordUsage(ctx, { provider: 'directonly', costMinor: 777, dedupeKey: 'direct-1' });
    expect(usage.costMinor).toBe(777);
    await setProviderBudget(admin, { scope: 'tenant', budgetMinor: 100, enforcement: 'block' });
    const blocked = await enforceProviderBudget(ctx, {
      gateway: 'llm',
      provider: 'directonly',
      capability: 'text-generation',
      projectedCostMinor: 10_000,
    });
    expect(blocked.decision).toBe('block');

    // Settlement refuses canonically, naming the external requirement.
    const error = await expectCode('settlement_direct_billing', () =>
      settleProviderUsage(ctx, {
        gateway: 'llm',
        provider: 'directonly',
        windowFrom: OCTOBER.from,
        windowTo: OCTOBER.to,
      }),
    );
    expect(error.message).toContain('bills this customer directly');
    expect(error.message).toContain('usage attribution and budgets continue to work');
    // No settlement row was minted for the refused path.
    expect(await listSettlements(ctx, {})).toEqual([]);
    // Usage remains readable and attributable.
    expect((await listUsageRecords(ctx, { provider: 'directonly' }))[0]!.id).toBe(usage.id);
  });

  it('detects receipt tampering through the recomputed digest', async () => {
    const tenant = newId();
    await seedMediated(tenant);
    const ctx = memberOf(tenant);
    const result = await settleProviderUsage(ctx, {
      gateway: 'llm',
      provider: 'openai',
      windowFrom: OCTOBER.from,
      windowTo: OCTOBER.to,
    });
    expect(result.receipt!.receiptDigest).toMatch(/^[0-9a-f]{64}$/);

    // Tamper with the stored digest (a lifecycle column — storage allows it).
    await getDb().query(
      `UPDATE provider_settlements SET receipt_digest = $3 WHERE tenant_id = $1 AND id = $2`,
      [tenant, result.settlement.id, '0'.repeat(64)],
    );
    await expectCode('settlement_invalid_state', () =>
      getSettlementReceipt(ctx, { settlementId: result.settlement.id }),
    );
  });
});

// ---------------------------------------------------------------------------
// The W034 composition bridge (llm gateway usage into the billing ledger)
// ---------------------------------------------------------------------------

describe('provider-billing service — the llm import bridge', () => {
  it('imports completed llm executions idempotently and settles them through Aurum', async () => {
    const tenant = newId();
    const llmAdmin = llmAdminOf(tenant);
    const ctx = memberOf(tenant);

    await registerAiProviderAccount(llmAdmin, {
      provider: 'openai',
      label: 'billing-test',
      credentialRef: `secret-store://openai/billing-test`,
      scopes: ['cognition'],
      capabilities: ['text-generation'],
      maxDataClassification: 'restricted',
      priority: 100,
    });
    const transport = new FakeLlmTransport();
    setLlmTransport(transport);
    const execution = await invokeLlm(ctx, {
      capability: 'text-generation',
      scope: 'cognition',
      dataClassification: 'internal',
      messages: [{ role: 'user', content: 'Is the gateway provider-neutral?' }],
    });
    expect(execution.status).toBe('completed');
    expect(execution.costMinor).toBeGreaterThan(0);
    expect(transport.requests).toHaveLength(1);

    const first = await importLlmUsage(ctx, {});
    expect(first.considered).toBe(1);
    expect(first.imported).toBe(1);
    expect(first.skipped).toBe(0);

    // Idempotent: the retry skips the already-imported execution.
    const second = await importLlmUsage(ctx, {});
    expect(second.considered).toBe(1);
    expect(second.imported).toBe(0);
    expect(second.skipped).toBe(1);

    const record = (await listUsageRecords(ctx, { gateway: 'llm' }))[0]!;
    expect(record.provider).toBe('openai');
    expect(record.capability).toBe('text-generation');
    expect(record.executionRef).toBe(execution.id);
    expect(record.accountRef).toBe(execution.accountId);
    expect(record.costMinor).toBe(execution.costMinor);
    expect(record.quantity).toBe(execution.inputTokens + execution.outputTokens);
    expect(record.unit).toBe('tokens');
    expect(record.source).toBe('llm-import');
    expect(record.occurredAt).toBe(execution.invokedAt);

    // The imported usage settles through the same canonical path.
    await registerPaymentArrangement(adminOf(tenant), {
      gateway: 'llm',
      provider: 'openai',
      arrangement: 'aurum-mediated',
      settlementAdapterKey: 'platform-account',
    });
    await allowSettlements(tenant);
    const settled = await settleProviderUsage(ctx, {
      gateway: 'llm',
      provider: 'openai',
      windowFrom: OCTOBER.from,
      windowTo: OCTOBER.to,
    });
    expect(settled.settlement.amountMinor).toBe(execution.costMinor);
    expect(settled.receipt!.usage.byCapability[0]!.capability).toBe('text-generation');
  });
});

// ---------------------------------------------------------------------------
// The W080 composition bridge (durable settlement workflow runs)
// ---------------------------------------------------------------------------

describe('provider-billing service — the durable settlement workflow bridge', () => {
  it('settles windows through a durable workflow run gated by the engine approval wait', async () => {
    const tenant = newId();
    const admin = adminOf(tenant);
    const starter = memberOf(tenant);

    await registerPaymentArrangement(admin, {
      gateway: 'llm',
      provider: 'openai',
      arrangement: 'aurum-mediated',
      settlementAdapterKey: 'platform-account',
    });
    await recordUsage(starter, { provider: 'openai', costMinor: 400, dedupeKey: 'wf-1', occurredAt: '2026-10-03T10:00:00Z' });
    await recordUsage(starter, { provider: 'openai', costMinor: 600, dedupeKey: 'wf-2', occurredAt: '2026-11-03T10:00:00Z' });

    await registerWorkflow(starter, {
      key: 'provider-billing.settlement',
      title: 'Provider billing settlement',
      spec: { steps: [{ key: 'settle-windows' }] },
    });
    const run = await startRun(starter, {
      definitionKey: 'provider-billing.settlement',
      input: {
        windows: [
          { gateway: 'llm', provider: 'openai', windowFrom: OCTOBER.from, windowTo: OCTOBER.to },
          { gateway: 'llm', provider: 'openai', windowFrom: NOVEMBER.from, windowTo: NOVEMBER.to },
        ],
      },
    });

    // Engine generation A: proposes the approval wait (default policy gates EXECUTE).
    const engineA = createWorkflowEngine(createSettlementWorkflowBindings(starter));
    const outcome1 = await engineA.pump(starter);
    expect(outcome1.status).toBe('suspended');
    const afterWait = await getRun(starter, { runId: run.id });
    expect(afterWait.status).toBe('waiting');

    // The approval request waits for a human decision.
    const requests = await listActionRequests(starter, { actionKind: 'provider-settlement' });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.status).toBe('pending');
    await decideApproval(approverOf(tenant), { requestId: requests[0]!.id, decision: 'approve' });

    // === ENGINE GENERATION A DIES (never consulted again) ===
    // A FRESH engine generation with fresh bindings resumes the SAME run.
    const engineB = createWorkflowEngine(createSettlementWorkflowBindings(starter));
    const outcome2 = await engineB.pump(starter);
    expect(outcome2.status).toBe('processed');
    const outcome3 = await engineB.pump(starter);
    expect(outcome3.status).toBe('processed');

    const finished = await getRun(starter, { runId: run.id });
    expect(finished.status).toBe('succeeded');
    expect(finished.result).toEqual({ settled: expect.arrayContaining([expect.any(String)]), skipped: 0 });
    const settledIds = (finished.result as { settled: string[] }).settled;
    expect(settledIds).toHaveLength(2);

    const settlements = await listSettlements(starter, {});
    expect(settlements).toHaveLength(2);
    expect(settlements.every((s) => s.status === 'settled')).toBe(true);
    expect(settlements.map((s) => s.amountMinor).sort((a, b) => b - a)).toEqual([600, 400]);
    for (const settlement of settlements) {
      const receipt = await getSettlementReceipt(starter, { settlementId: settlement.id });
      expect(receipt.receiptDigest).toMatch(/^[0-9a-f]{64}$/);
    }
    // Exactly one charge per settlement window — no duplicates across engine generations.
    expect(backend.chargeCalls.filter((c) => c.adapter === 'platform-account')).toHaveLength(2);
  });

  it('skips windows with nothing to settle and fails fast on forbidden policy', async () => {
    const tenant = newId();
    const starter = memberOf(tenant);
    await registerPaymentArrangement(adminOf(tenant), {
      gateway: 'llm',
      provider: 'openai',
      arrangement: 'aurum-mediated',
      settlementAdapterKey: 'platform-account',
    });

    // Nothing to settle → the run completes with skipped windows.
    await registerWorkflow(starter, {
      key: 'provider-billing.settlement',
      title: 'Provider billing settlement',
      spec: { steps: [{ key: 'settle-windows' }] },
    });
    const run = await startRun(starter, {
      definitionKey: 'provider-billing.settlement',
      input: {
        windows: [
          { gateway: 'llm', provider: 'openai', windowFrom: OCTOBER.from, windowTo: OCTOBER.to },
        ],
      },
    });
    const engine = createWorkflowEngine(createSettlementWorkflowBindings(starter));
    await engine.pump(starter); // propose the approval wait
    const requests = await listActionRequests(starter, { actionKind: 'provider-settlement' });
    await decideApproval(approverOf(tenant), { requestId: requests[0]!.id, decision: 'approve' });
    await engine.pump(starter); // released → nothing to settle → skip → done
    const finished = await getRun(starter, { runId: run.id });
    expect(finished.status).toBe('succeeded');
    expect(finished.result).toEqual({ settled: [], skipped: 1 });

    // A forbidden policy fails the run deterministically on the fresh invocation
    // (maxAttempts 1: the policy refusal is a deterministic failure).
    const tenant2 = newId();
    const starter2 = memberOf(tenant2);
    await setAuthorityPolicy(policyAdminOf(tenant2), {
      actionKind: 'provider-settlement',
      forbiddenLevels: ['EXECUTE'],
    });
    await registerWorkflow(starter2, {
      key: 'provider-billing.settlement',
      title: 'Provider billing settlement',
      spec: { steps: [{ key: 'settle-windows', maxAttempts: 1 }] },
    });
    const run2 = await startRun(starter2, {
      definitionKey: 'provider-billing.settlement',
      input: {
        windows: [
          { gateway: 'llm', provider: 'openai', windowFrom: OCTOBER.from, windowTo: OCTOBER.to },
        ],
      },
    });
    const engine2 = createWorkflowEngine(createSettlementWorkflowBindings(starter2));
    await engine2.pump(starter2);
    const failed = await getRun(starter2, { runId: run2.id });
    expect(failed.status).toBe('failed');
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation + storage discipline
// ---------------------------------------------------------------------------

describe('provider-billing service — tenant isolation and storage discipline', () => {
  it('keeps every surface tenant-scoped (uniform not-found, disjoint listings)', async () => {
    const tenantIsolation = newId();
    const adminA = adminOf(tenantIsolation);
    const ctxA = memberOf(tenantIsolation);
    const tenantB = newId();
    const ctxB = memberOf(tenantB);

    for (const [ctx, key] of [
      [ctxA, 'iso-a'],
      [ctxB, 'iso-b'],
    ] as Array<[TenantContext, string]>) {
      await registerPaymentArrangement(adminOf(ctx.tenantId), {
        gateway: 'llm',
        provider: 'openai',
        arrangement: 'aurum-mediated',
        settlementAdapterKey: 'platform-account',
      });
      await allowSettlements(ctx.tenantId);
      await recordUsage(ctx, { costMinor: 100, dedupeKey: key });
      await setProviderBudget(adminOf(ctx.tenantId), { scope: 'tenant', budgetMinor: 1_000, enforcement: 'block' });
      const settled = await settleProviderUsage(ctx, {
        gateway: 'llm',
        provider: 'openai',
        windowFrom: OCTOBER.from,
        windowTo: OCTOBER.to,
      });
      expect(settled.settlement.status).toBe('settled');
    }

    // Cross-tenant reads are uniformly not-found.
    const settlementA = (await listSettlements(ctxA, {}))[0]!;
    const usageA = (await listUsageRecords(ctxA, {}))[0]!;
    const budgetA = (await listProviderBudgets(ctxA, {}))[0]!;
    await expectCode('settlement_not_found', () => getSettlement(ctxB, { settlementId: settlementA.id }));
    await expectCode('settlement_not_found', () =>
      getSettlementReceipt(ctxB, { settlementId: settlementA.id }),
    );
    await expectCode('settlement_not_found', () =>
      listSettlementEvents(ctxB, { settlementId: settlementA.id }),
    );
    await expectCode('usage_not_found', () => getUsageRecord(ctxB, { usageId: usageA.id }));
    // An arrangement registered ONLY in tenant A is invisible to tenant B.
    await registerPaymentArrangement(adminA, {
      gateway: 'agents',
      provider: 'runtime-x',
      arrangement: 'aurum-mediated',
      settlementAdapterKey: 'platform-account',
    });
    await expectCode('arrangement_not_found', () =>
      getPaymentArrangement(ctxB, { gateway: 'agents', provider: 'runtime-x' }),
    );
    await expectCode('budget_not_found', () =>
      retireProviderBudget(adminOf(tenantB), { budgetId: budgetA.id }),
    );

    // Listings are disjoint.
    expect(await listSettlements(ctxB, {})).toHaveLength(1);
    expect((await listSettlements(ctxB, {}))[0]!.id).not.toBe(settlementA.id);
    expect(await listUsageRecords(ctxB, {})).toHaveLength(1);
    expect(await listBudgetEvents(ctxB, {})).toHaveLength(0);
    expect((await getUsageSummary(ctxB, {})).costMinor).toBe(100);

    // Tenant B's budget enforcement counts ONLY tenant B's usage.
    const enforcement = await enforceProviderBudget(ctxB, {
      gateway: 'llm',
      provider: 'openai',
      capability: 'text-generation',
      projectedCostMinor: 0,
    });
    expect(enforcement.postures[0]!.spendMinor).toBe(100);
  });

  it('enforces the storage-level discipline (append-only triggers, guarded state machine)', async () => {
    const tenant = newId();
    const ctx = memberOf(tenant);
    const usage = await recordUsage(ctx, { costMinor: 10, dedupeKey: 'storage-1' });
    await expect(
      getDb().query(`UPDATE provider_usage_records SET cost_minor = 5 WHERE id = $1`, [usage.id]),
    ).rejects.toThrow(/append-only/);
    await expect(
      getDb().query(`DELETE FROM provider_usage_records WHERE id = $1`, [usage.id]),
    ).rejects.toThrow(/append-only/);

    const admin = adminOf(tenant);
    await allowSettlements(tenant);
    await registerPaymentArrangement(admin, {
      gateway: 'llm',
      provider: 'openai',
      arrangement: 'aurum-mediated',
      settlementAdapterKey: 'platform-account',
    });
    await recordUsage(ctx, { costMinor: 20, dedupeKey: 'storage-2' });
    const settled = await settleProviderUsage(ctx, {
      gateway: 'llm',
      provider: 'openai',
      windowFrom: OCTOBER.from,
      windowTo: OCTOBER.to,
    });
    await expect(
      getDb().query(`UPDATE provider_settlements SET window_from = now() WHERE id = $1`, [
        settled.settlement.id,
      ]),
    ).rejects.toThrow(/only the lifecycle state/);
    await expect(
      getDb().query(`DELETE FROM provider_settlements WHERE id = $1`, [settled.settlement.id]),
    ).rejects.toThrow(/durable history/);
    await expect(
      getDb().query(`DELETE FROM provider_settlement_lines WHERE settlement_id = $1`, [
        settled.settlement.id,
      ]),
    ).rejects.toThrow(/append-only/);

    const budget = await setProviderBudget(admin, { scope: 'tenant', budgetMinor: 999, enforcement: 'observe' });
    await expect(
      getDb().query(`UPDATE provider_budgets SET scope = 'gateway' WHERE id = $1`, [budget.id]),
    ).rejects.toThrow(/only the controls/);
    // The CONTROLS may move (an updatable management control).
    await getDb().query(`UPDATE provider_budgets SET budget_minor = 500 WHERE id = $1`, [budget.id]);
    const reread = await getDb().query<{ budget_minor: string }>(
      `SELECT budget_minor FROM provider_budgets WHERE id = $1`,
      [budget.id],
    );
    expect(Number(reread.rows[0]!.budget_minor)).toBe(500);
  });
});
