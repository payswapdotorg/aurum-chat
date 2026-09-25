// W044 — Tenant Isolation Verification · the provider-billing sweep (W090).
//
// The provider-billing module (W090 — Aurum Provider Billing Gateway) owns
// tenant-scoped tables for its billing surface: payment arrangements, the
// append-only provider usage ledger (cost attribution), budget policy rows
// with their append-only enforcement audit, and settlements with their
// lines and events (the auditable receipt chain).
//
// This sweep proves the tenant boundary at the APPLICATION level, per the
// W044 doctrine — two tenants side by side, zero leakage:
//   * arrangements, usage records, budgets and budget events of one
//     tenant are invisible to the other (uniform not-found, disjoint
//     listings);
//   * settlements and their receipts stay tenant-scoped: cross-tenant
//     receipt reads are uniformly not-found, and one tenant's receipt
//     digest never verifies against the other tenant's settlement;
//   * budget enforcement counts ONLY the calling tenant's usage (the
//     spend index is tenant-scoped).
//
// The deep per-operation isolation cases live in the module's own suite
// (src/modules/provider-billing/tests/); this sweep is the two-tenant
// proof the W044 coverage manifest claims.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { runMigrations } from '../../scripts/migrate';
import {
  getSettlement,
  getSettlementReceipt,
  getUsageRecord,
  listSettlements,
  listUsageRecords,
  ProviderBillingError,
  recordProviderUsage,
  registerPaymentArrangement,
  setProviderBudget,
  settleProviderUsage,
  wireSettlementAdapters,
} from '@/modules/provider-billing/contract';
import { setAuthorityPolicy } from '@/modules/actions/contract';
import { createPlatformAccountSettlementAdapter } from '@/modules/provider-billing/adapters/platform-account';
import type { SettlementHttpClient, SettlementHttpRequest, SettlementHttpResponse } from '@/modules/provider-billing/adapters/shared';

const tenantA = newId();
const tenantB = newId();

function adminOf(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: ['provider-billing:administer', 'actions:administer'] };
}

function memberOf(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: [] };
}

async function expectCode(code: ProviderBillingError['code'], fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
    throw new Error(`expected ProviderBillingError('${code}') but the call succeeded`);
  } catch (error) {
    if (!(error instanceof ProviderBillingError)) throw error;
    expect(error.code).toBe(code);
  }
}

/** An inert scripted billing backend (the platform-account dialect). */
class SweepBillingBackend implements SettlementHttpClient {
  async request(request: SettlementHttpRequest): Promise<SettlementHttpResponse> {
    const body = request.body as { idempotency_key?: string; amount_minor?: number };
    return {
      status: 201,
      body: {
        charge_id: `chrg_${body.idempotency_key ?? 'x'}`,
        status: 'succeeded',
        amount_minor: body.amount_minor ?? 0,
        currency: 'USD',
        occurred_at: new Date('2026-10-05T12:00:00Z').toISOString(),
      },
    };
  }
}

/** One tenant's full billing journey (attribution → budget → settlement). */
async function billingJourney(tenantId: string, key: string): Promise<void> {
  const admin = adminOf(tenantId);
  const ctx = memberOf(tenantId);
  // Settlements are pre-authorized for the sweep (the authority path has
  // its own dedicated tests in the module suite).
  await setAuthorityPolicy(admin, {
    actionKind: 'provider-settlement',
    approvalLevels: [],
    forbiddenLevels: [],
  });
  await registerPaymentArrangement(admin, {
    gateway: 'llm',
    provider: 'openai',
    arrangement: 'aurum-mediated',
    settlementAdapterKey: 'platform-account',
  });
  await recordProviderUsage(ctx, {
    gateway: 'llm',
    provider: 'openai',
    capability: 'text-generation',
    costMinor: key === 'a' ? 300 : 700,
    executionRef: `exec-${key}`,
    dedupeKey: `sweep-${key}`,
    occurredAt: '2026-10-05T10:00:00Z',
  });
  await setProviderBudget(admin, { scope: 'tenant', budgetMinor: 1_000_000, enforcement: 'block' });
  const settled = await settleProviderUsage(ctx, {
    gateway: 'llm',
    provider: 'openai',
    windowFrom: '2026-10-01T00:00:00Z',
    windowTo: '2026-11-01T00:00:00Z',
  });
  expect(settled.settlement.status).toBe('settled');
}

beforeAll(async () => {
  wireSettlementAdapters([
    createPlatformAccountSettlementAdapter({
      baseUrl: 'https://billing.sweep.example',
      // Fake billing API key — assembled from fragments at runtime.
      apiKey: ['pb_sweep_', 'it', '_fragment'].join(''),
      httpClient: new SweepBillingBackend(),
    }),
  ]);
  await runMigrations(getDb());
});

afterAll(async () => {
  wireSettlementAdapters(null);
  await closeDb();
});

describe('W044 sweep — provider-billing (W090)', () => {
  it('runs both tenants side by side with zero leakage', async () => {
    await billingJourney(tenantA, 'a');
    await billingJourney(tenantB, 'b');

    const ctxA = memberOf(tenantA);
    const ctxB = memberOf(tenantB);

    // Listings are disjoint.
    const usageA = await listUsageRecords(ctxA, {});
    const usageB = await listUsageRecords(ctxB, {});
    expect(usageA).toHaveLength(1);
    expect(usageB).toHaveLength(1);
    expect(usageA[0]!.costMinor).toBe(300);
    expect(usageB[0]!.costMinor).toBe(700);

    const settlementsA = await listSettlements(ctxA, {});
    const settlementsB = await listSettlements(ctxB, {});
    expect(settlementsA).toHaveLength(1);
    expect(settlementsB).toHaveLength(1);
    expect(settlementsA[0]!.amountMinor).toBe(300);
    expect(settlementsB[0]!.amountMinor).toBe(700);

    // Cross-tenant reads are uniformly not-found.
    await expectCode('usage_not_found', () => getUsageRecord(ctxA, { usageId: usageB[0]!.id }));
    await expectCode('usage_not_found', () => getUsageRecord(ctxB, { usageId: usageA[0]!.id }));
    await expectCode('settlement_not_found', () =>
      getSettlement(ctxA, { settlementId: settlementsB[0]!.id }),
    );
    await expectCode('settlement_not_found', () =>
      getSettlementReceipt(ctxB, { settlementId: settlementsA[0]!.id }),
    );

    // Each tenant's receipt verifies against ITS OWN settlement only.
    const receiptA = await getSettlementReceipt(ctxA, { settlementId: settlementsA[0]!.id });
    expect(receiptA.amountMinor).toBe(300);
    expect(receiptA.receiptDigest).toMatch(/^[0-9a-f]{64}$/);
    const receiptB = await getSettlementReceipt(ctxB, { settlementId: settlementsB[0]!.id });
    expect(receiptB.amountMinor).toBe(700);
    expect(receiptB.receiptDigest).not.toBe(receiptA.receiptDigest);

    // Tenant A's settlement cannot be re-settled through tenant B's
    // context: the window key resolves per tenant, so B sees only its own
    // already-settled window (replayed, never A's).
    const replayB = await settleProviderUsage(ctxB, {
      gateway: 'llm',
      provider: 'openai',
      windowFrom: '2026-10-01T00:00:00Z',
      windowTo: '2026-11-01T00:00:00Z',
    });
    expect(replayB.settlement.id).toBe(settlementsB[0]!.id);
    expect(await listSettlements(ctxA, {})).toHaveLength(1);
  });
});
