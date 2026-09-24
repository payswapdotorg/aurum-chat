// Typed errors of the connection-broker module. Consumers catch
// `ConnectionBrokerError` and branch on `code`; messages are for
// humans/logs, never for control flow.
//
// Cross-tenant access is deliberately indistinguishable from a missing
// record (`connection_not_found` / `checkpoint_not_found`) — the existence
// of another tenant's connections, checkpoints, health state or swap
// evidence must never leak (ADR-0001).
//
// Outage localization (W082 acceptance; W089 §9 failure isolation): a
// broker or upstream-provider failure NEVER surfaces as a raw provider
// error or a domain fault. It surfaces as `broker_failure` carrying the
// CANONICAL normalized failure (`failure`), while the observed outage is
// recorded as append-only provider-health evidence (see the service).
// `provider_outage` is the explicit fast-fail of the cooldown gate while a
// recorded outage is still cooling down — checkpoints and domain state
// stay untouched either way.

import type { CanonicalProviderFailure } from '@/modules/provider-sdk/contract';

export type ConnectionBrokerErrorCode =
  | 'invalid_context'
  | 'invalid_input'
  | 'invalid_query'
  | 'unsupported_provider'
  | 'unsupported_broker'
  | 'connection_not_found'
  | 'connection_conflict'
  | 'connection_invalid_state'
  | 'connection_authorization_expired'
  | 'broker_unavailable'
  | 'broker_failure'
  | 'provider_outage'
  | 'invalid_broker_result'
  | 'invalid_webhook_payload'
  | 'checkpoint_not_found'
  | 'hot_swap_unavailable';

export class ConnectionBrokerError extends Error {
  /**
   * The canonical normalized failure when this error wraps a broker/
   * provider interaction failure (W089 taxonomy — provider outages are
   * localized, never provider-native). Null for caller errors.
   */
  public readonly failure: CanonicalProviderFailure | null;

  constructor(
    public readonly code: ConnectionBrokerErrorCode,
    message: string,
    failure: CanonicalProviderFailure | null = null,
  ) {
    super(message);
    this.name = 'ConnectionBrokerError';
    this.failure = failure;
  }
}
