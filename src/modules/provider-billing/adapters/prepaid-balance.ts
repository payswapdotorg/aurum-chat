// Prepaid-balance settlement adapter (MODULE-INTERNAL — the billing
// provider's native wire dialect never crosses this file).
//
// The materially different billing mechanics (the two-adapter proof): a
// PREPAID ledger the charge draws DOWN. The tenant funds a balance with
// the billing provider up front; each settlement posts a debit under an
// idempotency key and the provider refuses (409) when the balance is
// insufficient — a canonical 'quota_exhausted' failure, localized to the
// adapter, never a domain fault. A duplicate idempotency key replays the
// original debit without drawing down twice (exactly-once charging per
// logical settlement).
//
// Wire dialect (prepaid-ledger shaped):
//   POST /v1/debits { idempotency_key, amount_minor, currency,
//                     description, metadata }
//     → 201 { debit_id, balance_minor_after, amount_minor, currency,
//             occurred_at }
//     → 200 { debit_id, duplicate: true, … } on an already-applied key
//     → 409 { error: 'insufficient_balance' } → quota_exhausted
//     → 401/403/429/5xx … canonical failure mapping
//
// Alongside its port duties this adapter is a conforming W089
// ProviderAdapterDefinition (canonical lifecycle, capabilities, error
// normalization — proven by the module's conformance suite).

import {
  createProviderAdapterDefinition,
  type CanonicalErrorCategory,
  type ProviderAdapterDefinition,
} from '@/modules/provider-sdk/contract';
import type {
  ProviderSettlementAdapter,
  SettlementChargeRequest,
  SettlementChargeResult,
} from '../types';
import {
  SETTLEMENT_ADAPTER_CAPABILITIES,
  SETTLEMENT_GATEWAY,
  SettlementAdapterError,
  createSettlementDialectHelpers,
  performRequest,
  type SettlementHttpClient,
} from './shared';

/** The canonical adapter key of the prepaid-balance adapter. */
export const PREPAID_BALANCE_ADAPTER_KEY = 'prepaid-balance';

export interface PrepaidBalanceAdapterConfig {
  /** The prepaid billing provider's base URL (no trailing slash). */
  baseUrl: string;
  /** The billing API key — wiring-time config, never persisted. */
  apiKey: string;
  /** The injected network client (real fetch adapter or a test double). */
  httpClient: SettlementHttpClient;
}

function classifyPrepaidBalanceError(error: unknown): CanonicalErrorCategory | null {
  if (error instanceof SettlementAdapterError) return error.failure.category;
  if (error instanceof Error && /insufficient balance|balance exhausted/i.test(error.message)) {
    return 'quota_exhausted';
  }
  return null;
}

/** Mint the prepaid-balance settlement adapter. */
export function createPrepaidBalanceSettlementAdapter(
  config: PrepaidBalanceAdapterConfig,
): ProviderSettlementAdapter {
  const helpers = createSettlementDialectHelpers(PREPAID_BALANCE_ADAPTER_KEY);
  const authHeaders: Record<string, string> = {
    Authorization: `Bearer ${config.apiKey}`,
  };

  const definition: ProviderAdapterDefinition = createProviderAdapterDefinition({
    gateway: SETTLEMENT_GATEWAY,
    provider: PREPAID_BALANCE_ADAPTER_KEY,
    capabilities: SETTLEMENT_ADAPTER_CAPABILITIES,
    classifyError: classifyPrepaidBalanceError,
  });

  async function charge(request: SettlementChargeRequest): Promise<SettlementChargeResult> {
    const body = await performRequest(config.httpClient, PREPAID_BALANCE_ADAPTER_KEY, {
      method: 'POST',
      path: '/v1/debits',
      headers: authHeaders,
      body: {
        idempotency_key: request.idempotencyKey,
        amount_minor: request.amountMinor,
        currency: request.currency,
        description: request.description,
        metadata: {
          settlement_id: request.settlementId,
          tenant_id: request.tenantId,
          gateway: request.gateway,
          provider: request.provider,
          occurred_at: request.occurredAt,
        },
      },
    });
    const envelope = helpers.requireObject(body, 'the prepaid-balance debit result');
    const debitId = helpers.requireString(envelope.debit_id, 'the prepaid-balance debit_id');
    const amount = helpers.requireNonNegativeInteger(
      envelope.amount_minor,
      'the prepaid-balance debit amount_minor',
    );
    if (amount !== request.amountMinor) {
      throw helpers.malformed(
        'the prepaid-balance debit amount_minor',
        `must equal the debited request amount (${request.amountMinor}, got ${amount})`,
      );
    }
    const balanceAfter = helpers.requireNonNegativeInteger(
      envelope.balance_minor_after,
      'the prepaid-balance balance_minor_after',
    );
    const occurredAt = helpers.requireIsoInstant(
      envelope.occurred_at,
      'the prepaid-balance debit occurred_at',
    );
    return {
      receiptRef: debitId,
      receiptPayload: {
        kind: 'prepaid-balance-debit',
        debitId,
        amountMinor: amount,
        currency: request.currency,
        balanceMinorAfter: balanceAfter,
        duplicate: envelope.duplicate === true,
        occurredAt,
      },
      amountMinor: amount,
      currency: request.currency,
    };
  }

  return { key: PREPAID_BALANCE_ADAPTER_KEY, definition, charge };
}
