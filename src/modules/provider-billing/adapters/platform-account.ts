// Platform-account settlement adapter (MODULE-INTERNAL — the billing
// provider's native wire dialect never crosses this file).
//
// The charge-on-account mechanics: every charge is posted to the platform
// billing provider's account ledger under an idempotency key — the
// tenant's platform account is invoiced by the provider on its own
// billing cycle, and Aurum records the provider's receipt reference for
// each charge. A duplicate idempotency key replays the original charge
// (exactly-once charging per logical settlement).
//
// Wire dialect (platform-billing shaped):
//   POST /v1/charges { idempotency_key, amount_minor, currency,
//                      description, metadata }
//     → 201 { charge_id, status: 'succeeded', amount_minor, currency,
//             occurred_at }
//     → 200 { charge_id, status: 'succeeded', duplicate: true, … } on an
//           already-applied idempotency key
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

/** The canonical adapter key of the platform-account adapter. */
export const PLATFORM_ACCOUNT_ADAPTER_KEY = 'platform-account';

export interface PlatformAccountAdapterConfig {
  /** The platform billing provider's base URL (no trailing slash). */
  baseUrl: string;
  /** The billing API key — wiring-time config, never persisted. */
  apiKey: string;
  /** The injected network client (real fetch adapter or a test double). */
  httpClient: SettlementHttpClient;
}

function classifyPlatformAccountError(error: unknown): CanonicalErrorCategory | null {
  if (error instanceof SettlementAdapterError) return error.failure.category;
  if (error instanceof Error && /account suspended|account frozen/i.test(error.message)) {
    return 'quota_exhausted';
  }
  return null;
}

/** Mint the platform-account settlement adapter. */
export function createPlatformAccountSettlementAdapter(
  config: PlatformAccountAdapterConfig,
): ProviderSettlementAdapter {
  const helpers = createSettlementDialectHelpers(PLATFORM_ACCOUNT_ADAPTER_KEY);
  const authHeaders: Record<string, string> = {
    Authorization: `Bearer ${config.apiKey}`,
  };

  const definition: ProviderAdapterDefinition = createProviderAdapterDefinition({
    gateway: SETTLEMENT_GATEWAY,
    provider: PLATFORM_ACCOUNT_ADAPTER_KEY,
    capabilities: SETTLEMENT_ADAPTER_CAPABILITIES,
    classifyError: classifyPlatformAccountError,
  });

  async function charge(request: SettlementChargeRequest): Promise<SettlementChargeResult> {
    const body = await performRequest(config.httpClient, PLATFORM_ACCOUNT_ADAPTER_KEY, {
      method: 'POST',
      path: '/v1/charges',
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
    const envelope = helpers.requireObject(body, 'the platform-account charge result');
    const chargeId = helpers.requireString(envelope.charge_id, 'the platform-account charge_id');
    const status = helpers.requireString(envelope.status, 'the platform-account charge status');
    if (status !== 'succeeded') {
      throw helpers.malformed(
        'the platform-account charge status',
        `must be 'succeeded' (got '${status}')`,
      );
    }
    const amount = helpers.requireNonNegativeInteger(
      envelope.amount_minor,
      'the platform-account charge amount_minor',
    );
    if (amount !== request.amountMinor) {
      throw helpers.malformed(
        'the platform-account charge amount_minor',
        `must equal the charged request amount (${request.amountMinor}, got ${amount})`,
      );
    }
    const occurredAt = helpers.requireIsoInstant(
      envelope.occurred_at,
      'the platform-account charge occurred_at',
    );
    return {
      receiptRef: chargeId,
      // Normalized, provider-neutral receipt payload (digest material).
      receiptPayload: {
        kind: 'platform-account-charge',
        chargeId,
        amountMinor: amount,
        currency: request.currency,
        duplicate: envelope.duplicate === true,
        occurredAt,
      },
      amountMinor: amount,
      currency: request.currency,
    };
  }

  return { key: PLATFORM_ACCOUNT_ADAPTER_KEY, definition, charge };
}
