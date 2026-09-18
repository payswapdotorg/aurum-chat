// Typed errors of the destinations module. Consumers catch
// `DestinationsError` and branch on `code`; messages are for humans/logs,
// never for control flow.
//
// Cross-tenant access is deliberately indistinguishable from a missing
// record (`destination_not_found` / `delivery_not_found`) — the existence
// of another tenant's connectors or outbound deliveries must never leak
// (ADR-0001). This covers every id-bearing lookup: get, dispatch, retry,
// replay, status changes and attempt reads.
//
// Provider availability mirrors the sources/channels discipline: without a
// wired transport no provider delivery is possible — that state is the
// explicit `provider_unavailable`, never a silent no-op or a fake success.
//
// Evidence-level authorization (the W004 usage tags this module consumes,
// per the actions module's dependency posture note) fails loudly:
// `evidence_not_found` (missing, foreign-tenant or not readable by the
// calling principal — uniformly no leak) and `evidence_export_forbidden`
// (an observation tagged `no-export` can never leave through a
// destination).

export type DestinationsErrorCode =
  | 'invalid_context'
  | 'invalid_destination_input'
  | 'invalid_destination_query'
  | 'invalid_delivery_input'
  | 'invalid_delivery_query'
  | 'invalid_delivery_records'
  | 'unsupported_provider'
  | 'destination_not_found'
  | 'destination_conflict'
  | 'destination_disabled'
  | 'destination_authorization_expired'
  | 'delivery_not_found'
  | 'delivery_conflict'
  | 'delivery_not_retryable'
  | 'delivery_busy'
  | 'evidence_not_found'
  | 'evidence_export_forbidden'
  | 'provider_unavailable'
  | 'invalid_envelope'
  | 'invalid_transport_receipt';

export class DestinationsError extends Error {
  constructor(
    public readonly code: DestinationsErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DestinationsError';
  }
}
