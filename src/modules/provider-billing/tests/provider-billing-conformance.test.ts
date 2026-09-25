// W089 — the two-adapter proof for the provider-billing gateway: the
// platform-account and prepaid-balance settlement adapters are conforming
// ProviderAdapterDefinitions with MATERIALLY DIFFERENT billing mechanics
// (charge-on-account vs prepaid draw-down). This suite runs the
// provider-sdk conformance kit against both REAL adapters, including
// error specimens drawn from their native dialects (a scripted backend
// speaking both wire shapes).
//
// What this proves (WORK-ITEM-CATALOG W090 ← W089; GOVERNANCE.md
// "Provider swap evidence" as applied to the settlement seam): two
// materially different billing providers satisfy the SAME canonical
// lifecycle, capability-reporting and error-normalization contracts,
// produced by the ONE template (createProviderAdapterDefinition) — so a
// third settlement adapter is creatable from the kit alone, and swapping
// the active adapter changes no domain contract.
//
// No hot-swap evidence emitter is supplied here, deliberately: settlement
// adapters are not interchangeable AI capability providers (GOVERNANCE
// "Provider swap evidence" targets the same provider-independent
// CAPABILITY through two providers); the two-adapter pluggability of the
// settlement seam is proven by this conformance suite plus the service
// suite's adapter-behavior cases (each adapter settles the same canonical
// usage window with unchanged domain semantics).

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { describe, expect, it } from 'vitest';
import {
  defineAdapterConformanceSuite,
  type AdapterConformanceSubject,
} from '@/modules/provider-sdk/contract';
import {
  createPlatformAccountSettlementAdapter,
  PLATFORM_ACCOUNT_ADAPTER_KEY,
} from '../adapters/platform-account';
import {
  createPrepaidBalanceSettlementAdapter,
  PREPAID_BALANCE_ADAPTER_KEY,
} from '../adapters/prepaid-balance';
import type { SettlementHttpClient, SettlementHttpRequest, SettlementHttpResponse } from '../adapters/shared';

// ---------------------------------------------------------------------------
// A scripted backend speaking both adapters' native dialects
// ---------------------------------------------------------------------------

/**
 * A fake billing-provider backend implementing the platform-account and
 * prepaid-ledger wire dialects over the shared SettlementHttpClient port.
 * The charge endpoints honor IDEMPOTENCY KEYS exactly like real billing
 * providers (the exactly-once charging contract the settlement core
 * depends on).
 */
class ScriptedBillingBackend implements SettlementHttpClient {
  readonly requests: SettlementHttpRequest[] = [];
  readonly charges = new Map<
    string,
    { amountMinor: number; adapter: string; receiptRef: string; balanceAfter: number | null }
  >();
  /** Simulated per-provider statuses (e.g. 500 outage, 409 refusal). */
  failureStatus: number | null = null;
  private counter = 0;
  private balance = 5_000_000;

  private receiptRef(adapter: string): string {
    this.counter += 1;
    return `${adapter === PLATFORM_ACCOUNT_ADAPTER_KEY ? 'chrg' : 'dbt'}_${String(this.counter).padStart(6, '0')}`;
  }

  async request(request: SettlementHttpRequest): Promise<SettlementHttpResponse> {
    this.requests.push(request);
    if (this.failureStatus !== null) {
      const status = this.failureStatus;
      this.failureStatus = null;
      return { status, body: { error: 'simulated billing failure' } };
    }
    if (request.method === 'POST' && request.path === '/v1/charges') {
      const body = request.body as { idempotency_key?: string; amount_minor?: number };
      const key = body.idempotency_key ?? '';
      const existing = this.charges.get(key);
      if (existing !== undefined && existing.adapter === PLATFORM_ACCOUNT_ADAPTER_KEY) {
        return {
          status: 200,
          body: {
            charge_id: existing.receiptRef,
            status: 'succeeded',
            duplicate: true,
            amount_minor: existing.amountMinor,
            currency: 'USD',
            occurred_at: new Date().toISOString(),
          },
        };
      }
      const receiptRef = this.receiptRef(PLATFORM_ACCOUNT_ADAPTER_KEY);
      this.charges.set(key, {
        amountMinor: body.amount_minor ?? 0,
        adapter: PLATFORM_ACCOUNT_ADAPTER_KEY,
        receiptRef,
        balanceAfter: null,
      });
      return {
        status: 201,
        body: {
          charge_id: receiptRef,
          status: 'succeeded',
          amount_minor: body.amount_minor ?? 0,
          currency: 'USD',
          occurred_at: new Date().toISOString(),
        },
      };
    }
    if (request.method === 'POST' && request.path === '/v1/debits') {
      const body = request.body as { idempotency_key?: string; amount_minor?: number };
      const key = body.idempotency_key ?? '';
      const existing = this.charges.get(key);
      if (existing !== undefined && existing.adapter === PREPAID_BALANCE_ADAPTER_KEY) {
        return {
          status: 200,
          body: {
            debit_id: existing.receiptRef,
            duplicate: true,
            amount_minor: existing.amountMinor,
            currency: 'USD',
            balance_minor_after: existing.balanceAfter,
            occurred_at: new Date().toISOString(),
          },
        };
      }
      const amount = body.amount_minor ?? 0;
      if (amount > this.balance) {
        return { status: 409, body: { error: 'insufficient_balance' } };
      }
      this.balance -= amount;
      const receiptRef = this.receiptRef(PREPAID_BALANCE_ADAPTER_KEY);
      this.charges.set(key, {
        amountMinor: amount,
        adapter: PREPAID_BALANCE_ADAPTER_KEY,
        receiptRef,
        balanceAfter: this.balance,
      });
      return {
        status: 201,
        body: {
          debit_id: receiptRef,
          amount_minor: amount,
          currency: 'USD',
          balance_minor_after: this.balance,
          occurred_at: new Date().toISOString(),
        },
      };
    }
    return { status: 404, body: { error: 'unknown endpoint' } };
  }
}

const backend = new ScriptedBillingBackend();

// Fake billing API keys — assembled from fragments at runtime (never a
// realistic full token literal in source).
const platformKey = ['pb_platform_', 'conf', '_fragment'].join('');
const prepaidKey = ['pb_prepaid_', 'conf', '_fragment'].join('');

const platformAccount = createPlatformAccountSettlementAdapter({
  baseUrl: 'https://billing.platform.example',
  apiKey: platformKey,
  httpClient: backend,
});

const prepaidBalance = createPrepaidBalanceSettlementAdapter({
  baseUrl: 'https://prepaid.billing.example',
  apiKey: prepaidKey,
  httpClient: backend,
});

// ---------------------------------------------------------------------------
// The two conformance subjects
// ---------------------------------------------------------------------------

const platformSubject: AdapterConformanceSubject = {
  definition: platformAccount.definition,
  gateway: 'provider-billing',
  expectedCapabilities: ['usage-settlement', 'settlement-receipts'],
  errorSpecimens: [
    {
      description: 'a suspended platform account',
      error: new Error('account suspended for non-payment'),
      expectedCategory: 'quota_exhausted',
    },
    {
      description: 'a connection reset while posting the charge',
      error: new Error('ECONNRESET while posting charge'),
      expectedCategory: 'provider_unavailable',
    },
  ],
};

const prepaidSubject: AdapterConformanceSubject = {
  definition: prepaidBalance.definition,
  gateway: 'provider-billing',
  expectedCapabilities: ['usage-settlement', 'settlement-receipts'],
  errorSpecimens: [
    {
      description: 'an exhausted prepaid balance',
      error: new Error('insufficient balance for debit'),
      expectedCategory: 'quota_exhausted',
    },
    {
      description: 'a request timeout against the prepaid ledger',
      error: Object.assign(new Error('the ledger request timed out'), { name: 'TimeoutError' }),
      expectedCategory: 'timeout',
    },
  ],
};

defineAdapterConformanceSuite(platformSubject, { describe, it });
defineAdapterConformanceSuite(prepaidSubject, { describe, it });

// ---------------------------------------------------------------------------
// The materially-different-mechanics proof (beyond the kit's shape checks)
// ---------------------------------------------------------------------------

describe('settlement adapter pair — materially different mechanics, same contract', () => {
  it('both adapters are wired and declare the canonical keys', () => {
    expect(platformAccount.key).toBe(PLATFORM_ACCOUNT_ADAPTER_KEY);
    expect(prepaidBalance.key).toBe(PREPAID_BALANCE_ADAPTER_KEY);
    expect(PLATFORM_ACCOUNT_ADAPTER_KEY).not.toBe(PREPAID_BALANCE_ADAPTER_KEY);
  });

  it('each adapter charges through ITS dialect and returns a normalized receipt', async () => {
    const platformReceipt = await platformAccount.charge({
      settlementId: '11111111-1111-4111-8111-111111111111',
      tenantId: '22222222-2222-4222-8222-222222222222',
      gateway: 'llm',
      provider: 'openai',
      amountMinor: 1_500,
      currency: 'USD',
      idempotencyKey: 'conf-platform-1',
      description: 'conformance charge',
      occurredAt: '2026-10-05T10:00:00Z',
    });
    expect(platformReceipt.receiptRef).toMatch(/^chrg_\d{6}$/);
    expect(platformReceipt.amountMinor).toBe(1_500);
    expect((platformReceipt.receiptPayload as Record<string, unknown>).kind).toBe(
      'platform-account-charge',
    );

    const prepaidReceipt = await prepaidBalance.charge({
      settlementId: '33333333-3333-4333-8333-333333333333',
      tenantId: '22222222-2222-4222-8222-222222222222',
      gateway: 'llm',
      provider: 'anthropic',
      amountMinor: 2_500,
      currency: 'USD',
      idempotencyKey: 'conf-prepaid-1',
      description: 'conformance debit',
      occurredAt: '2026-10-05T10:00:00Z',
    });
    expect(prepaidReceipt.receiptRef).toMatch(/^dbt_\d{6}$/);
    expect((prepaidReceipt.receiptPayload as Record<string, unknown>).kind).toBe(
      'prepaid-balance-debit',
    );
    expect((prepaidReceipt.receiptPayload as Record<string, unknown>).balanceMinorAfter).toBe(
      4_997_500,
    );

    // The two dialects hit different endpoints — materially different wires.
    const paths = backend.requests.slice(-2).map((request) => request.path);
    expect(paths).toEqual(['/v1/charges', '/v1/debits']);
  });

  it('idempotent charge replays return the ORIGINAL receipt without double charging', async () => {
    const request = {
      settlementId: '44444444-4444-4444-8444-444444444444',
      tenantId: '22222222-2222-4222-8222-222222222222',
      gateway: 'llm',
      provider: 'openai',
      amountMinor: 700,
      currency: 'USD' as const,
      idempotencyKey: 'conf-idem-key',
      description: 'idempotency probe',
      occurredAt: '2026-10-05T10:00:00Z',
    };
    const first = await platformAccount.charge(request);
    const replay = await platformAccount.charge(request);
    expect(replay.receiptRef).toBe(first.receiptRef);
    expect((replay.receiptPayload as Record<string, unknown>).duplicate).toBe(true);
    expect(backend.charges.size).toBe(3); // platform, prepaid, idem — no fourth charge
  });

  it('a billing outage normalizes canonically (W089 taxonomy), never a raw provider error', async () => {
    backend.failureStatus = 503;
    await expect(
      platformAccount.charge({
        settlementId: '55555555-5555-4555-8555-555555555555',
        tenantId: '22222222-2222-4222-8222-222222222222',
        gateway: 'llm',
        provider: 'openai',
        amountMinor: 10,
        currency: 'USD',
        idempotencyKey: 'conf-outage',
        description: 'outage probe',
        occurredAt: '2026-10-05T10:00:00Z',
      }),
    ).rejects.toMatchObject({
      name: 'SettlementAdapterError',
      failure: { category: 'provider_unavailable', retryable: true },
    });
  });

  it('an exhausted prepaid balance refuses canonically (quota_exhausted)', async () => {
    await expect(
      prepaidBalance.charge({
        settlementId: '66666666-6666-4666-8666-666666666666',
        tenantId: '22222222-2222-4222-8222-222222222222',
        gateway: 'llm',
        provider: 'openai',
        amountMinor: 900_000_000,
        currency: 'USD',
        idempotencyKey: 'conf-exhausted',
        description: 'exhaustion probe',
        occurredAt: '2026-10-05T10:00:00Z',
      }),
    ).rejects.toMatchObject({
      name: 'SettlementAdapterError',
      failure: { category: 'quota_exhausted', recovery: 'operator' },
    });
  });
});
