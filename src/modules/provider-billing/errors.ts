// Typed errors of the provider-billing module. Consumers catch
// `ProviderBillingError` and branch on `code`; messages are for
// humans/logs, never for control flow.
//
// Cross-tenant access is deliberately indistinguishable from a missing
// record (`usage_not_found` / `settlement_not_found` / `budget_not_found`
// / `arrangement_not_found`) — the existence of another tenant's usage,
// settlements, budgets or arrangements must never leak (ADR-0001).
//
// Failure localization (W089 §9 failure isolation): a settlement-adapter
// or billing-provider failure NEVER surfaces as a raw provider error or a
// domain fault. It surfaces as `settlement_adapter_failure` carrying the
// CANONICAL normalized failure (`failure`), while the settlement row
// itself records the failed attempt as append-only evidence.

import type { CanonicalProviderFailure } from '@/modules/provider-sdk/contract';

export type ProviderBillingErrorCode =
  | 'invalid_context'
  | 'invalid_input'
  | 'invalid_query'
  | 'arrangement_not_found'
  | 'arrangement_conflict'
  | 'arrangement_retired'
  | 'settlement_direct_billing'
  | 'settlement_adapter_unavailable'
  | 'settlement_adapter_failure'
  | 'settlement_approval_required'
  | 'settlement_forbidden'
  | 'settlement_invalid_state'
  | 'settlement_in_flight'
  | 'settlement_nothing_to_settle'
  | 'settlement_not_found'
  | 'usage_not_found'
  | 'budget_not_found'
  | 'unauthorized';

export class ProviderBillingError extends Error {
  /**
   * The canonical normalized failure when this error wraps a settlement
   * adapter / billing-provider interaction failure (W089 taxonomy —
   * billing outages are localized, never provider-native). Null for
   * caller errors.
   */
  public readonly failure: CanonicalProviderFailure | null;

  /**
   * The pending W009 action request id when code is
   * `settlement_approval_required` (approve it through the actions module,
   * then retry with the same idempotency key).
   */
  public readonly actionRequestId: string | null;

  constructor(
    public readonly code: ProviderBillingErrorCode,
    message: string,
    failure: CanonicalProviderFailure | null = null,
    actionRequestId: string | null = null,
  ) {
    super(message);
    this.name = 'ProviderBillingError';
    this.failure = failure;
    this.actionRequestId = actionRequestId;
  }
}
